"""대피 행동요령 생성 Agent (LangGraph StateGraph).

설계 원칙 (기획서 8-3 준수):
  AI는 경로나 화재 위치를 판단하지 않는다.
  이미 계산된 경로 + 시설 정보를 '사람이 읽을 문장'으로 바꾸기만 한다.
  그래프 안에서 경로를 다시 계산하지 않는다 (pathfinder 를 호출하지 않는다).

흐름 (그래프가 제어한다):

    START
      │ route_entry: OPENAI_API_KEY 없음 또는 route.status != "ok"
      ├──────────────────────────────────────────────┐
      ▼                                              │
    summarize   경로 결과 → LLM 입력 요약             │
      │  (추후) retrieve: 매뉴얼 검색(RAG) 자리        │
      ▼                                              │
    generate    OpenAI 호출. 예외는 state.error 에 기록 │
      ▼                                              │
    validate    형식·금지 표현·노드ID·목적지 분기 검사   │
      │ route_after_validate                          │
      ├── 통과 ──▶ finalize  source="ai", 주의문구 추가 │
      └── 실패/에러 ─▶ fallback ◀─────────────────────┘
                        기존 템플릿 안내
    finalize / fallback ──▶ END

langgraph 를 import 할 수 없으면 같은 노드 함수를 같은 순서로 순차 실행한다.
어떤 경우에도 generate_guide 는 예외를 던지지 않고 안내문(최소한 폴백)을 반환한다.
"""

import json
import logging
import os
import re
from typing import Optional, TypedDict

try:
    from langgraph.graph import END, START, StateGraph

    _LANGGRAPH_AVAILABLE = True
except Exception:  # noqa: BLE001 - 라이브러리가 없거나 깨져도 서비스는 살아 있어야 한다
    END = START = StateGraph = None
    _LANGGRAPH_AVAILABLE = False

log = logging.getLogger(__name__)

MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# --------------------------------------------------------------------------
# 프롬프트
# --------------------------------------------------------------------------
SYSTEM_PROMPT = """당신은 BF Manual의 '화재 대피 행동요령 작성기'입니다.
경로는 이미 안전 경로 탐색 엔진이 계산해 두었습니다.
당신의 역할은 그 계산 결과를, 화재 현장에서 긴장한 사람이 휴대폰으로 한눈에 읽을 수 있는
짧은 행동요령 문장으로 바꾸는 것뿐입니다.

[절대 규칙]
1. 경로를 판단하거나 바꾸지 않습니다.
   - 입력의 '이동_순서'에 있는 장소만, 그 순서대로 언급합니다.
   - 입력에 없는 방향(왼쪽·오른쪽·위·아래 등), 장소, 층, 출구, 계단을 새로 만들지 않습니다.
   - 더 가깝거나 더 안전한 다른 길이 있다고 말하지 않습니다.
2. 목적지 종류를 그대로 따릅니다.
   - 목적지_종류가 "exit"이면: 비상구를 통해 건물 밖으로 나가 집결지로 이동하도록 안내합니다.
   - 목적지_종류가 "refuge"이면: 대피공간에 들어가 방화문을 닫고 구조를 기다리도록 안내합니다.
     이 경우 '건물 밖으로 나가라', '계단으로 내려가라', '집결지로 가라'는 표현을 절대 쓰지 않습니다.
3. 엘리베이터·승강기는 어떤 문맥으로도 언급하지 않습니다. (주의사항은 시스템이 따로 붙입니다)
4. 노드 ID(예: F3-C1)나 영문 코드는 쓰지 않고, 입력의 한국어 장소 이름만 씁니다.
5. 입력에 없는 설비(소화기, 비상통화장치 등)는 언급하지 않습니다. '시설_정보'에 있는 설비만 언급할 수 있습니다.
6. 이름·연락처 등 개인정보를 묻거나 적게 하지 않습니다.
7. 공포를 키우는 표현, 추측("아마", "~일 수도"), 전문용어를 쓰지 않습니다.

[문장 작성 방법]
- 모든 문장은 "~하세요"로 끝나는 명령형 존댓말, 한 문장 40자 이내.
- headline: 목적지 이름이 들어간 한 문장. 예) "3층 서측 대피공간으로 이동하세요"
- steps: 3~5개. 실제 이동 순서대로.
  · 계단 구간이 있으면 "몇 층에서 몇 층으로" 이동하는 단계를 반드시 포함합니다.
  · 방화문 구간이 있으면 "방화문을 통과한 뒤 닫으세요"를 포함합니다.
  · 마지막 단계는 도착 후 행동입니다. (exit: 집결지 이동 / refuge: 방화문 닫고 119에 위치 알리기)
- cautions: 0~3개. 입력에 근거가 있을 때만 씁니다.
  · '연기_통과_구간'이 비어 있지 않으면: 해당 장소 이름과 함께 낮은 자세·코와 입 가리기를 안내합니다.
  · '위험_변화'가 있으면: 그 내용을 쉬운 말로 한 문장씩 옮깁니다.
  · 입력에 '단차' 구간이 있으면: 해당 구간에서 천천히 이동하라고 안내합니다.
- 대피자_상태에 맞춰 어조를 조정합니다.
  · 휠체어 이용 / 도움이 필요함: 서두르기보다 안전하게 이동하고 주변에 도움을 요청하라고 안내합니다.
  · 보행 보조기구 사용: 벽이나 난간을 짚으며 천천히 이동하라고 안내합니다.

[출력 형식]
아래 JSON 객체 하나만 출력합니다. 코드블록, 설명, 다른 키를 덧붙이지 않습니다.
{
  "headline": "문자열",
  "steps": ["문자열", "..."],
  "cautions": ["문자열"]
}"""

HUMAN_PROMPT = """아래는 안전 경로 탐색 엔진이 계산한 결과입니다.
이 결과만 근거로 대피 행동요령 JSON을 작성하세요.

{summary}"""

REQUIRED_KEYS = ("headline", "steps", "cautions")
FORBIDDEN = ("엘리베이터", "승강기")  # 화재 시 절대 안내하면 안 되는 표현
# 대피공간(refuge) 안내에서 나오면 안 되는 표현 - 목적지 분기 원칙 보호
FORBIDDEN_REFUGE = ("건물 밖", "밖으로 나가", "외부로", "집결지", "내려가")
NODE_ID_PATTERN = re.compile(r"F\d+-[A-Z0-9-]+")

DISCLAIMER = "AI가 생성한 안내입니다. 현장 상황과 다를 수 있으니 반드시 눈으로 확인하세요."

KIND_LABEL = {
    "corridor": "복도",
    "door": "출입문",
    "fire_door": "방화문",
    "stair": "계단",
}


# --------------------------------------------------------------------------
# 1) summarize
# --------------------------------------------------------------------------
def summarize(route: dict) -> str:
    """경로 결과를 LLM이 읽기 쉬운 형태로 정리한다. 노드 ID는 이름으로 치환한다."""
    if route["status"] != "ok":
        return "경로 계산 실패"

    names = {n["id"]: n for n in route["path"]}

    def label(node_id: str) -> str:
        n = names.get(node_id)
        if not n:
            return node_id
        floor = f"{n['floor']}층"
        return n["name"] if floor in n["name"] else f"{n['name']}({floor})"

    moves = []
    for leg in route["legs"]:
        kind = KIND_LABEL.get(leg["kind"], leg["kind"])
        text = f"{label(leg['from'])} → {label(leg['to'])} : {kind} {leg['dist']}m"
        if leg.get("step") and leg["kind"] != "stair":
            text += " (단차 있음)"
        moves.append(text)

    return json.dumps(
        {
            "대피자_상태": route["mobility_label"],
            "현재_위치": label(route["start"]["id"]),
            "목적지": label(route["destination"]["id"]),
            "목적지_종류": route["destination_type"],
            "총_거리_m": route["distance_m"],
            "예상_소요_초": route["eta_sec"],
            "이동_순서": moves,
            "연기_통과_구간": [label(i) for i in route["passes_smoke"]],
            "위험_변화": [r for r in route["hazard"]["reasons"] if r],
            "시설_정보": route.get("facility") or {},
        },
        ensure_ascii=False,
        indent=2,
    )


# --------------------------------------------------------------------------
# 2) generate
# --------------------------------------------------------------------------
def _call_openai(summary: str) -> dict:
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import SystemMessage, HumanMessage

    llm = ChatOpenAI(
        model=MODEL,
        temperature=0.2,
        # 프론트(api.js) 요청 제한이 8초이므로, 재시도 없이 5초 안에 끝내고 폴백으로 넘긴다
        timeout=5,
        max_retries=0,
        model_kwargs={"response_format": {"type": "json_object"}},
    )
    resp = llm.invoke(
        [
            SystemMessage(content=SYSTEM_PROMPT),
            HumanMessage(content=HUMAN_PROMPT.format(summary=summary)),
        ]
    )
    text = resp.content.strip()
    if text.startswith("```"):
        text = text.split("```")[1].lstrip("json").strip()
    return json.loads(text)


# --------------------------------------------------------------------------
# 3) validate
# --------------------------------------------------------------------------
def validate(guide: dict, route: dict = None) -> bool:
    if not isinstance(guide, dict) or not all(k in guide for k in REQUIRED_KEYS):
        return False
    if not isinstance(guide["headline"], str) or not guide["headline"].strip():
        return False
    steps, cautions = guide["steps"], guide["cautions"]
    if not isinstance(steps, list) or not (1 <= len(steps) <= 6):
        return False
    if not isinstance(cautions, list):
        return False
    if not all(isinstance(s, str) and s.strip() for s in steps + cautions):
        return False

    blob = json.dumps(guide, ensure_ascii=False)
    if any(word in blob for word in FORBIDDEN):
        log.warning("금지 표현이 포함되어 폴백 처리: %s", blob[:200])
        return False
    if NODE_ID_PATTERN.search(blob):
        log.warning("노드 ID가 노출되어 폴백 처리: %s", blob[:200])
        return False
    if route and route.get("destination_type") == "refuge":
        if any(word in blob for word in FORBIDDEN_REFUGE):
            log.warning("대피공간 안내에 외부 대피 표현이 섞여 폴백 처리: %s", blob[:200])
            return False
    return True


# --------------------------------------------------------------------------
# 4) fallback
# --------------------------------------------------------------------------
def fallback(route: dict) -> dict:
    if route["status"] != "ok":
        return {
            "headline": "안전한 경로를 찾지 못했습니다",
            "steps": [
                "현재 위치에서 벗어나 방화구획 대피공간으로 이동하세요.",
                "젖은 천으로 문틈을 막아 연기 유입을 차단하세요.",
                "119에 위치를 알리고 구조를 기다리세요.",
            ],
            "cautions": [route["reason"]] if route.get("reason") else [],
            "source": "fallback",
            "disclaimer": DISCLAIMER,
        }

    dest = route["destination"]
    is_exit = route["destination_type"] == "exit"
    steps = [
        "문을 열기 전 손으로 문 표면 온도를 확인하세요.",
        "자세를 낮추고 벽을 짚으며 이동하세요.",
        f"{dest['name']}까지 약 {route['distance_m']}m 이동하세요.",
    ]
    steps.append(
        "건물 밖으로 나온 뒤 집결지로 이동하세요."
        if is_exit
        else "대피공간에 들어가면 방화문을 닫고 119에 위치를 알린 뒤 구조를 기다리세요."
    )
    cautions = ["화재 시 엘리베이터를 사용하지 마세요."]
    if route["passes_smoke"]:
        cautions.append("경로 일부에 연기가 있습니다. 낮은 자세를 유지하세요.")
    cautions += [r for r in route["hazard"]["reasons"] if r]

    return {
        "headline": f"{dest['name']}(으)로 이동하세요",
        "steps": steps,
        "cautions": cautions,
        "source": "fallback",
        "disclaimer": DISCLAIMER,
    }


# --------------------------------------------------------------------------
# 그래프 상태
# --------------------------------------------------------------------------
class GuideState(TypedDict, total=False):
    route: dict              # pathfinder 결과 (읽기 전용)
    summary: str             # summarize 노드 결과
    guide: Optional[dict]    # generate 결과 → finalize/fallback 에서 최종 안내문
    error: Optional[str]     # generate 예외 또는 validate 실패 사유
    source: Optional[str]    # "ai" | "fallback"


ELEVATOR_CAUTION = "화재 시 엘리베이터를 사용하지 마세요."


# --------------------------------------------------------------------------
# 노드 — 위의 summarize / _call_openai / validate / fallback 을 감싸기만 한다
# 노드는 state 를 직접 바꾸지 않고 바뀐 키만 dict 로 돌려준다.
# --------------------------------------------------------------------------
def summarize_node(state: GuideState) -> dict:
    return {"summary": summarize(state["route"])}


def generate_node(state: GuideState) -> dict:
    try:
        # 모듈 전역 _call_openai 를 호출 시점에 찾는다 (테스트에서 교체 가능)
        return {"guide": _call_openai(state["summary"]), "error": None}
    except Exception as exc:  # noqa: BLE001 - 예외는 밖으로 던지지 않고 기록 후 fallback 으로 보낸다
        log.warning("AI 호출 실패(%s) → 폴백", exc)
        return {"guide": None, "error": f"generate: {type(exc).__name__}: {exc}"}


def validate_node(state: GuideState) -> dict:
    if state.get("error"):
        return {"error": state["error"]}  # generate 단계 에러는 그대로 넘긴다
    if validate(state.get("guide"), state["route"]):
        return {"error": None}
    log.warning("AI 응답 검증 실패 → 폴백")
    return {"error": "validate: AI 응답이 검증 규칙을 통과하지 못함"}


def finalize_node(state: GuideState) -> dict:
    guide = dict(state["guide"])
    guide["source"] = "ai"
    guide["disclaimer"] = DISCLAIMER
    guide["cautions"] = list(guide.get("cautions", [])) + [ELEVATOR_CAUTION]
    return {"guide": guide, "source": "ai"}


def fallback_node(state: GuideState) -> dict:
    return {"guide": fallback(state["route"]), "source": "fallback"}


# --------------------------------------------------------------------------
# 라우터 (조건부 엣지)
# --------------------------------------------------------------------------
def route_entry(state: GuideState) -> str:
    """시작 분기: AI 를 쓸 수 없거나 경로가 없으면 곧바로 fallback."""
    if not os.getenv("OPENAI_API_KEY"):
        return "fallback"
    if state["route"].get("status") != "ok":
        return "fallback"
    return AI_PIPELINE[0][0]


def route_after_validate(state: GuideState) -> str:
    return "fallback" if state.get("error") else "finalize"


# AI 안내문을 만드는 직선 구간. 위에서부터 순서대로 연결되고, 마지막 노드 뒤에서
# route_after_validate 로 finalize / fallback 이 갈린다 (마지막은 validate 여야 한다).
# 노드를 추가할 때는 이 목록에 (이름, 함수) 한 줄만 끼워 넣으면 된다.
AI_PIPELINE = [
    ("summarize", summarize_node),
    # ("retrieve", retrieve_node),  # 추후 RAG(매뉴얼 검색) 노드 자리: summarize → retrieve → generate
    #   retrieve 는 매뉴얼 문단을 state 에 더할 뿐, 경로·목적지를 바꾸지 않는다.
    ("generate", generate_node),
    ("validate", validate_node),
]


def _build_graph():
    builder = StateGraph(GuideState)

    for name, node in AI_PIPELINE:
        builder.add_node(name, node)
    builder.add_node("finalize", finalize_node)
    builder.add_node("fallback", fallback_node)

    first = AI_PIPELINE[0][0]
    last = AI_PIPELINE[-1][0]

    builder.add_conditional_edges(START, route_entry, {first: first, "fallback": "fallback"})
    for (current, _), (following, _) in zip(AI_PIPELINE, AI_PIPELINE[1:]):
        builder.add_edge(current, following)
    builder.add_conditional_edges(
        last, route_after_validate, {"finalize": "finalize", "fallback": "fallback"}
    )
    builder.add_edge("finalize", END)
    builder.add_edge("fallback", END)
    return builder.compile()


# 모듈 로드 시 한 번만 compile 해서 재사용한다
GUIDE_GRAPH = None
if _LANGGRAPH_AVAILABLE:
    try:
        GUIDE_GRAPH = _build_graph()
    except Exception:  # noqa: BLE001
        log.exception("LangGraph 그래프 구성 실패 → 순차 실행으로 동작")
        GUIDE_GRAPH = None


def _run_sequential(state: GuideState) -> GuideState:
    """langgraph 가 없을 때: 그래프와 같은 노드·같은 분기를 순서대로 실행한다."""
    state = dict(state)
    if route_entry(state) == "fallback":
        state.update(fallback_node(state))
        return state
    for _, node in AI_PIPELINE:
        state.update(node(state))
    final_node = finalize_node if route_after_validate(state) == "finalize" else fallback_node
    state.update(final_node(state))
    return state


def _safe_fallback(route) -> dict:
    """마지막 안전장치. route 가 깨져 있어도 기존 폴백 문구로 안내한다."""
    try:
        return fallback(route)
    except Exception as exc:  # noqa: BLE001
        log.warning("폴백 생성 실패(%s) → 경로 없음 안내로 대체", exc)
        return fallback({"status": "no_route", "reason": ""})


# --------------------------------------------------------------------------
# 공개 함수 (시그니처·반환 형태 유지)
# --------------------------------------------------------------------------
def generate_guide(route: dict) -> dict:
    initial: GuideState = {"route": route, "summary": "", "guide": None, "error": None, "source": None}
    try:
        if GUIDE_GRAPH is not None:
            final = GUIDE_GRAPH.invoke(initial)
        else:
            final = _run_sequential(initial)
        guide = final.get("guide")
        if isinstance(guide, dict):
            return guide
        log.warning("그래프가 안내문을 만들지 못함 → 폴백")
    except Exception as exc:  # noqa: BLE001
        log.warning("행동요령 그래프 실행 실패(%s) → 폴백", exc)
    return _safe_fallback(route)
