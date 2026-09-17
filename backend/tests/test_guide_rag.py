"""RAG(매뉴얼 검색) 행동요령 Agent 검증. 네트워크 없이 monkeypatch 로만 동작한다.

확인하는 것:
  - 원칙 1: retrieve 는 route 를 바꾸지 않고, 참고 자료가 새 층·출구를 만들면 검증에서 막힌다.
  - 원칙 3: 휠체어·이동 불가에게 계단 하강·외부 대피 문단이 가지 않는다.
  - 원칙 4: 키 없음 / 검색 실패·시간 초과 / langgraph 없음에서도 안내가 끝까지 나온다.
  - 원칙 5: 엘리베이터·승강기 문단은 검색 결과에 나오지 않는다.

테스트 문단은 이 파일 안의 테스트 전용 문장이며 실제 기관 매뉴얼이 아니다.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import copy
import importlib
import random
import time
from contextlib import contextmanager

from app.services import graph_loader as gl
from app.services import guide_agent as ga
from app.services import manual_retriever as mr
from app.services.mobility import get_profile
from app.services.pathfinder import find_route

DUMMY_KEY = "sk-test-dummy"
RETRIEVE_TIMING = {}


# --------------------------------------------------------------------------
# 도우미
# --------------------------------------------------------------------------
def route_for(mobility, events=None, start="F2-R205"):
    hazard = gl.apply_events(gl.get_scenario("demo-1"), events or [])
    return find_route(start, get_profile(mobility), hazard)


@contextmanager
def patched(target, name, value):
    original = getattr(target, name)
    setattr(target, name, value)
    try:
        yield
    finally:
        setattr(target, name, original)


@contextmanager
def api_key(value=DUMMY_KEY):
    """OPENAI_API_KEY 를 잠시 바꾼다. value=None 이면 없는 상태."""
    saved = os.environ.get("OPENAI_API_KEY")
    if value is None:
        os.environ.pop("OPENAI_API_KEY", None)
    else:
        os.environ["OPENAI_API_KEY"] = value
    try:
        yield
    finally:
        os.environ.pop("OPENAI_API_KEY", None)
        if saved is not None:
            os.environ["OPENAI_API_KEY"] = saved


@contextmanager
def use_index(entries):
    """manual_index.json 대신 테스트 문단을 읽게 하고, 검색기 캐시를 비운다."""
    normalized = [e for e in map(mr._normalize_entry, entries) if e]
    mr.reset_cache()
    try:
        with patched(mr, "load_index", lambda path=None: normalized):
            yield
    finally:
        mr.reset_cache()


def paragraph(pid, tags, text, title="테스트 문서 A", vector=None):
    entry = {"id": pid, "tags": tags, "text": text, "title": title,
             "publisher": "테스트 발행처", "url": "https://example.invalid/test"}
    if vector is not None:
        entry["embedding"] = vector
    return entry


# 테스트 전용 문단 (실제 매뉴얼 아님)
TEST_INDEX = [
    paragraph("exit-stairs", ["exit"], "계단으로 내려가 비상구를 통해 건물 밖으로 대피하세요."),
    paragraph("exit-common", ["exit", "common"], "비상구로 나온 뒤 집결지에서 인원을 확인하세요."),
    paragraph("refuge", ["refuge"], "대피공간에 들어가면 방화문을 닫고 119에 위치를 알린 뒤 구조를 기다리세요."),
    paragraph("refuge-common", ["refuge", "common"], "방화문을 통과한 뒤에는 반드시 닫아 연기가 퍼지지 않게 하세요."),
    paragraph("common", ["common"], "문을 열기 전 손으로 문 표면 온도를 확인하세요.", title="테스트 문서 B"),
    paragraph("common-mistag", ["common"], "계단으로 내려가 건물 밖으로 대피하세요."),  # 태그를 잘못 단 문단
    paragraph("shelter", ["shelter"], "스스로 이동할 수 없으면 문을 닫고 문틈을 막은 뒤 119에 현재 위치를 알리세요."),
    paragraph("smoke", ["smoke"], "연기가 있으면 자세를 낮추고 젖은 천으로 코와 입을 가리세요."),
    paragraph("elevator-exit", ["exit"], "엘리베이터를 이용해 1층으로 대피하세요."),
    paragraph("elevator-refuge", ["refuge"], "피난용 승강기를 이용해 대피공간으로 이동하세요."),
    paragraph("elevator-common", ["common"], "승강기 이용이 가능하면 승강기로 이동하세요."),
]
ELEVATOR_IDS = {"elevator-exit", "elevator-refuge", "elevator-common"}

REFUGE_GUIDE = {
    "headline": "대피공간으로 이동하세요",
    "steps": ["자세를 낮추고 복도를 따라 이동하세요.", "방화문을 통과한 뒤 닫으세요.", "119에 위치를 알리고 구조를 기다리세요."],
    "cautions": [],
}
BASE_KEYS = {"headline", "steps", "cautions", "source", "disclaimer"}


def fake_generate(guide, calls):
    def _call(summary, references=None):
        calls.append({"summary": summary, "references": list(references or [])})
        return copy.deepcopy(guide)
    return _call


def initial_state(route):
    return {"route": route, "summary": "", "guide": None, "error": None,
            "source": None, "references": [], "retrieve_error": None}


def run_state(module, route):
    """최종 state 전체 (그래프가 있으면 그래프, 없으면 순차 실행)."""
    if module.GUIDE_GRAPH is not None:
        return module.GUIDE_GRAPH.invoke(initial_state(route))
    return module._run_sequential(initial_state(route))


def nodes_visited(route):
    if ga.GUIDE_GRAPH is None:
        return None
    return [next(iter(update)) for update in ga.GUIDE_GRAPH.stream(initial_state(route), stream_mode="updates")]


def raise_error(*args, **kwargs):
    raise RuntimeError("simulated retrieve failure")


@contextmanager
def without_langgraph():
    """langgraph import 를 막고 guide_agent 를 다시 불러온다. 끝나면 원래 모듈로 되돌린다."""
    saved_lg = {k: v for k, v in sys.modules.items() if k == "langgraph" or k.startswith("langgraph.")}
    saved_ga = sys.modules.pop("app.services.guide_agent")
    for name in saved_lg:
        del sys.modules[name]
    sys.modules["langgraph"] = None
    try:
        yield importlib.import_module("app.services.guide_agent")
    finally:
        sys.modules.pop("app.services.guide_agent", None)
        del sys.modules["langgraph"]
        sys.modules.update(saved_lg)
        sys.modules["app.services.guide_agent"] = saved_ga


def ids_of(references):
    return [r["id"] for r in references]


# --------------------------------------------------------------------------
# 1. 키 없음 → 곧바로 폴백, retrieve 미실행
# --------------------------------------------------------------------------
def test_01_no_key_falls_back_without_retrieve():
    route = route_for("wheelchair")
    searched, generated = [], []
    with api_key(None), use_index(TEST_INDEX), \
            patched(mr, "search_manuals", lambda *a, **k: searched.append(1) or ([], None)), \
            patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, generated)):
        guide = ga.generate_guide(route)
        visited = nodes_visited(route)
    assert guide["source"] == "fallback"
    assert guide == ga.fallback(route)
    assert searched == [] and generated == [], "키가 없는데 retrieve/generate 가 실행됨"
    assert "references" not in guide
    if visited is not None:
        assert visited == ["fallback"], visited


# --------------------------------------------------------------------------
# 2~4. 목적지 분기 (원칙 3)
# --------------------------------------------------------------------------
def test_02_wheelchair_gets_refuge_and_common_only():
    route = route_for("wheelchair")
    assert route["destination_type"] == "refuge"
    before = copy.deepcopy(route)
    with api_key(None), use_index(TEST_INDEX):
        state = ga.retrieve_node({"route": route})
        every = mr.retrieve(route, k=len(TEST_INDEX), index=TEST_INDEX)
    refs = state["references"]
    assert refs, "휠체어 경로에 참고 자료가 없음"
    assert state["retrieve_error"] is None
    for ref in refs + every:
        assert set(ref["tags"]) <= {"refuge", "common"}, ref
        assert not any(p in ref["text"] for p in mr.EXIT_ONLY_PHRASES), f"계단 하강·외부 대피 문단이 들어감: {ref['text']}"
    assert not {"exit-stairs", "exit-common", "common-mistag"} & set(ids_of(every))
    assert route == before, "retrieve 가 route 를 바꿈"


def test_03_independent_gets_exit_and_common():
    route = route_for("independent")
    assert route["destination_type"] == "exit"
    with api_key(None), use_index(TEST_INDEX):
        refs = ga.retrieve_node({"route": route})["references"]
    assert refs
    assert all(set(ref["tags"]) <= {"exit", "common"} for ref in refs), [r["tags"] for r in refs]
    assert any("exit" in ref["tags"] for ref in refs), "자력이동 경로에 exit 문단이 선택되지 않음"


def test_04_need_help_gets_shelter_and_common_only():
    route = route_for("need_help")
    with api_key(None), use_index(TEST_INDEX):
        refs = ga.retrieve_node({"route": route})["references"]
        every = mr.retrieve(route, k=len(TEST_INDEX), index=TEST_INDEX)
    assert refs
    assert all(set(ref["tags"]) <= {"shelter", "common"} for ref in refs + every), [r["tags"] for r in every]
    assert "shelter" in ids_of(refs)
    assert not any(p in ref["text"] for ref in every for p in mr.EXIT_ONLY_PHRASES)


# --------------------------------------------------------------------------
# 5. 엘리베이터 문단 제외 (원칙 5) — 키워드 검색과 임베딩 검색 모두
# --------------------------------------------------------------------------
def test_05_elevator_paragraphs_never_returned():
    routes = [route_for(m) for m in ("independent", "walking_aid", "wheelchair", "need_help")]
    routes.append(dict(route_for("wheelchair"), passes_smoke=["F2-C3"]))

    with api_key(None):
        for route in routes:
            found = mr.retrieve(route, k=len(TEST_INDEX), index=TEST_INDEX)
            assert not ELEVATOR_IDS & set(ids_of(found)), ids_of(found)

    # 임베딩 검색: 엘리베이터 문단이 질의와 가장 비슷하게 만들어도 제외되어야 한다
    embed_index = [dict(p, embedding=[1.0, 1.0, 1.0, 1.0] if p["id"] in ELEVATOR_IDS else [1.0, 0.0, 0.0, 0.0])
                   for p in TEST_INDEX]
    with api_key(), patched(mr, "_embed_query", lambda text, timeout: [1.0, 1.0, 1.0, 1.0]):
        mr.reset_cache()
        for route in routes:
            found = mr.retrieve(route, k=len(TEST_INDEX), index=embed_index)
            assert found and all(r["method"] == "embedding" for r in found)
            assert not ELEVATOR_IDS & set(ids_of(found)), ids_of(found)
        mr.reset_cache()


# --------------------------------------------------------------------------
# 6. retrieve 예외·시간 초과 → 참고 자료 없이 generate, source == "ai" (원칙 4)
# --------------------------------------------------------------------------
def test_06_retrieve_exception_continues_to_ai():
    route = route_for("wheelchair")
    calls = []
    with api_key(), use_index(TEST_INDEX), patched(mr, "search_manuals", raise_error), \
            patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, calls)):
        state = run_state(ga, route)
    assert state["guide"]["source"] == "ai"
    assert state["error"] is None
    assert state["retrieve_error"] == "error: RuntimeError"
    assert state["references"] == [] and calls and calls[-1]["references"] == []
    assert state["guide"]["references"] == []


def test_06_retrieve_timeout_continues_to_ai():
    route = route_for("wheelchair")
    calls = []
    vector_index = [dict(p, embedding=[1.0, 0.0]) for p in TEST_INDEX]
    slow_embed = lambda text, timeout: (time.sleep(1.0), [1.0, 0.0])[1]
    with api_key(), use_index(vector_index), patched(mr, "_embed_query", slow_embed), \
            patched(ga, "RETRIEVE_TIMEOUT", 0.3), patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, calls)):
        started = time.perf_counter()
        state = run_state(ga, route)
        elapsed = time.perf_counter() - started
        # 시간 초과로 버려진 검색 스레드가 끝날 때까지 기다린 뒤 캐시를 비운다
        # (늦게 끝난 스레드가 질의 캐시에 2차원 벡터를 남겨 다른 테스트에 섞이지 않게)
        time.sleep(max(0.0, 1.2 - elapsed))
    assert state["retrieve_error"] == "timeout", state["retrieve_error"]
    assert state["guide"]["source"] == "ai"
    assert state["references"] == [] and calls[-1]["references"] == []
    assert elapsed < 0.9, f"시간 초과가 지켜지지 않음: {elapsed:.2f}s"


# --------------------------------------------------------------------------
# 7. 참고 자료를 근거로 새 출구·층·외부 대피를 제시 → 검증에서 차단 (원칙 1·3)
# --------------------------------------------------------------------------
def test_07_refuge_route_blocks_exit_wording_from_references():
    route = route_for("wheelchair")
    leaked = {
        "headline": "1층 비상구로 이동하세요",
        "steps": ["계단으로 1층까지 내려가세요.", "건물 밖으로 나가 집결지로 이동하세요."],
        "cautions": [],
    }
    with api_key(), use_index(TEST_INDEX), patched(ga, "_call_openai", fake_generate(leaked, [])):
        guide = ga.generate_guide(route)
    assert guide["source"] == "fallback"
    assert guide == ga.fallback(route)


def gap_07_exit_route_new_floor_or_exit():
    """알려진 한계 확인용 (테스트로 세지 않음): exit 경로에서 AI 가 경로에 없는 층·출구를 만들어도
    현재 validate 규칙(엘리베이터·노드ID·대피공간 전용 금지어)로는 막히지 않는다. 결과 source 를 돌려준다."""
    route = route_for("independent")
    invented = {
        "headline": "지하 1층 3번 출구로 이동하세요",
        "steps": ["지하 1층으로 내려가세요.", "3번 출구로 나가세요."],
        "cautions": [],
    }
    with api_key(), use_index(TEST_INDEX), patched(ga, "_call_openai", fake_generate(invented, [])):
        return ga.generate_guide(route)["source"]


# --------------------------------------------------------------------------
# 8. finalize: references 추가 + 기존 키 5개 유지
# --------------------------------------------------------------------------
def test_08_finalize_adds_references_and_keeps_keys():
    route = route_for("wheelchair")
    calls = []
    with api_key(), use_index(TEST_INDEX), patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, calls)):
        guide = ga.generate_guide(route)
    assert guide["source"] == "ai"
    assert set(guide) == BASE_KEYS | {"references"}, sorted(guide)
    assert guide["cautions"][-1] == ga.ELEVATOR_CAUTION
    assert guide["disclaimer"] == ga.DISCLAIMER
    refs = guide["references"]
    assert refs and all(set(r) == {"title", "publisher", "url"} for r in refs)
    assert len({tuple(r.values()) for r in refs}) == len(refs), "출처 중복"
    used = {(r["title"], r["publisher"], r["url"]) for r in calls[-1]["references"]}
    assert {tuple(r.values()) for r in refs} == used

    duplicated = [paragraph("a", ["common"], "문장 1"), paragraph("b", ["common"], "문장 2")]
    state = {"route": route, "guide": copy.deepcopy(REFUGE_GUIDE), "references": duplicated}
    assert len(ga.finalize_node(state)["guide"]["references"]) == 1


# --------------------------------------------------------------------------
# 9. langgraph import 를 막아도 2·6 이 같은 결과
# --------------------------------------------------------------------------
def test_09_without_langgraph_same_results():
    route = route_for("wheelchair")
    calls_graph, calls_seq = [], []

    with api_key(), use_index(TEST_INDEX):
        with patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, calls_graph)):
            guide_graph = ga.generate_guide(route)
            retrieved_graph = ga.retrieve_node({"route": route})
        with patched(mr, "search_manuals", raise_error), patched(ga, "_call_openai", fake_generate(REFUGE_GUIDE, [])):
            failed_graph = run_state(ga, route)

        with without_langgraph() as sequential:
            assert sequential.GUIDE_GRAPH is None and not sequential._LANGGRAPH_AVAILABLE
            with patched(sequential, "_call_openai", fake_generate(REFUGE_GUIDE, calls_seq)):
                guide_seq = sequential.generate_guide(route)
                retrieved_seq = sequential.retrieve_node({"route": route})
            with patched(mr, "search_manuals", raise_error), \
                    patched(sequential, "_call_openai", fake_generate(REFUGE_GUIDE, [])):
                failed_seq = run_state(sequential, route)

    # 2번 조건: 같은 문단이 검색되고 같은 안내가 나온다
    assert retrieved_seq == retrieved_graph
    assert ids_of(calls_seq[-1]["references"]) == ids_of(calls_graph[-1]["references"])
    assert guide_seq == guide_graph and guide_seq["source"] == "ai"
    # 6번 조건: 검색이 실패해도 참고 자료 없이 같은 AI 안내
    assert failed_seq["guide"] == failed_graph["guide"] and failed_seq["guide"]["source"] == "ai"
    assert failed_seq["retrieve_error"] == failed_graph["retrieve_error"] == "error: RuntimeError"


# --------------------------------------------------------------------------
# 실행 시간: 캐시된 상태에서 retrieve 1회 < 0.2초 (문단 60개 × 1536차원)
# --------------------------------------------------------------------------
def test_10_cached_retrieve_is_fast():
    rng = random.Random(7)
    tag_cycle = [["refuge"], ["refuge", "common"], ["common"], ["exit"], ["shelter"], ["smoke"]]
    big = [paragraph(f"p{i:02d}", tag_cycle[i % 6], f"테스트 문단 {i} 방화문 대피공간 구조 대기",
                     vector=[rng.uniform(-1, 1) for _ in range(1536)]) for i in range(60)]
    query = [rng.uniform(-1, 1) for _ in range(1536)]
    route = route_for("wheelchair")

    with api_key(), use_index(big), patched(mr, "_embed_query", lambda text, timeout: query):
        mr.retrieve(route)  # 질의 임베딩 캐시 채우기
        timings = []
        for _ in range(10):
            started = time.perf_counter()
            found = mr.retrieve(route)
            timings.append(time.perf_counter() - started)
    RETRIEVE_TIMING.update(avg=sum(timings) / len(timings), worst=max(timings))
    assert found and found[0]["method"] == "embedding"
    assert max(timings) < 0.2, f"캐시 상태 retrieve 가 느림: {max(timings):.3f}s"


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.ERROR)  # 폴백 경고 로그는 숨기고 결과만 본다

    failed = []
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_"):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as exc:  # noqa: BLE001
                failed.append(name)
                print(f"FAIL {name}: {type(exc).__name__}: {exc}")

    if RETRIEVE_TIMING:
        print(f"\n[retrieve 캐시 상태 1회] 평균 {RETRIEVE_TIMING['avg'] * 1000:.1f}ms, "
              f"최대 {RETRIEVE_TIMING['worst'] * 1000:.1f}ms")
    source = gap_07_exit_route_new_floor_or_exit()
    print("[알려진 한계] exit 경로에서 AI 가 경로에 없는 층·출구를 제시했을 때:",
          "막히지 않음 (source=ai)" if source == "ai" else f"차단됨 (source={source})")
    sys.exit(1 if failed else 0)
