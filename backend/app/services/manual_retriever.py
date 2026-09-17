"""매뉴얼 검색(RAG) — 행동요령 Agent 의 retrieve 노드가 쓰는 검색기.

원칙:
  - 경로를 바꾸지 않는다 (원칙 1). route 는 읽기만 하고, 매뉴얼 문단 목록만 돌려준다.
  - 목적지 분기를 흐리지 않는다 (원칙 3). 태그로 먼저 거른 뒤 유사도로 고른다.
      exit 경로         → exit, common
      refuge 경로       → refuge, common
      이동 불가(need_help) → shelter, common   (경로의 destination_type 과 무관)
      연기 통과 경로     → 위 목록에 smoke 추가
    문단의 태그가 '모두' 허용 목록 안에 있어야 후보가 된다. (exit, common 문단은 휠체어에게 가지 않는다)
  - 엘리베이터·승강기를 언급하는 문단은 결과에서 제외한다 (원칙 5).
    인덱스 생성 스크립트에서도 같은 함수로 제외한다.
  - 실패해도 예외를 던지지 않는다 (원칙 4). 빈 목록이면 generate 는 참고 자료 없이 진행한다.
  - 개인정보를 쓰지 않는다 (원칙 6). 질의는 이동 상태·목적지 종류·연기 통과 여부로만 만든다.
  - 런타임에 파일을 쓰지 않는다. 미리 만든 manual_index.json 을 읽기만 한다.
  - 새 라이브러리 없이 동작한다. numpy 가 없으므로 코사인 유사도는 순수 파이썬으로 계산한다.

검색 순서:
  1) 인덱스 로드 (모듈 캐시, 파일이 바뀌었을 때만 다시 읽음)
  2) 태그 필터 + 엘리베이터 문단 제외 + (exit 가 아닌 경로) 계단 하강·외부 대피 문구 제외
  3) 질의 임베딩(메모리 캐시) 코사인 검색 — 키가 없거나 임베딩 호출이 실패하면
     문자 bigram 키워드 점수 검색으로 대체
  4) 결과 단계에서 엘리베이터 문단을 한 번 더 제외
전체는 timeout(기본 1.5초) 안에 끝나야 하며, 넘으면 빈 목록을 돌려준다.
"""

import json
import logging
import math
import os
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# 경로·상수 (인덱스 생성 스크립트와 공유)
# --------------------------------------------------------------------------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
MANUALS_DIR = DATA_DIR / "manuals"
INDEX_PATH = DATA_DIR / "manual_index.json"

# 인덱스 생성과 질의에 반드시 같은 모델을 써야 벡터를 비교할 수 있다
EMBEDDING_MODEL = "text-embedding-3-small"

VALID_TAGS = frozenset({"exit", "refuge", "shelter", "common", "smoke"})

# 엘리베이터 이용 권고/금지 여부를 문장 분석으로 가르지 않고, 언급 자체를 제외한다.
#   - 판별을 잘못하면 원칙 5가 깨진다.
#   - 금지 안내는 finalize·fallback 이 고정 문구로 이미 붙인다.
#   - 프롬프트에 단어가 들어가면 AI 출력이 FORBIDDEN 검증에 걸려 폴백될 가능성이 커진다.
ELEVATOR_WORDS = ("엘리베이터", "승강기")

# exit 가 아닌 경로(대피공간·제자리 대기)에 들어가면 안 되는 문구. 태그를 잘못 단 문단에 대한 2차 방어.
EXIT_ONLY_PHRASES = ("계단으로", "내려가", "건물 밖", "밖으로 나가", "외부로", "집결지")

DEFAULT_K = 3
DEFAULT_TIMEOUT = 1.5          # retrieve 전체 제한 시간(초)
EMBED_TIMEOUT = 1.0            # 질의 임베딩 호출 제한. 실패해도 키워드 검색할 시간을 남긴다
EMBED_RETRY_AFTER = 60.0       # 질의 임베딩이 실패한 조합은 이 시간 동안 다시 부르지 않는다

IMMOBILE_MOBILITY = "need_help"

MOBILITY_QUERY = {
    "independent": "혼자 이동할 수 있는 사람",
    "walking_aid": "보행 보조기구를 사용하는 사람",
    "wheelchair": "휠체어를 이용하는 사람",
    IMMOBILE_MOBILITY: "스스로 이동할 수 없는 사람",
}
DESTINATION_QUERY = {
    "exit": "화재 시 비상구를 통해 건물 밖으로 대피하는 행동요령",
    "refuge": "화재 시 방화구획 대피공간으로 이동해 문을 닫고 구조를 기다리는 행동요령",
    "shelter": "화재 시 이동하지 못할 때 있는 곳에서 안전을 확보하고 구조를 요청하는 행동요령",
}
SMOKE_QUERY = "연기가 있는 구간을 지날 때 자세를 낮추고 코와 입을 가리는 방법"

_WORD = re.compile(r"[0-9a-z가-힣]+")


# --------------------------------------------------------------------------
# 필터
# --------------------------------------------------------------------------
def is_elevator_paragraph(text: str) -> bool:
    """엘리베이터·승강기를 언급하는 문단인지 (인덱스 생성·검색 결과 양쪽에서 사용)."""
    return any(word in (text or "") for word in ELEVATOR_WORDS)


def allowed_tags(route: dict) -> frozenset:
    """route 에서 허용되는 매뉴얼 태그. 이동 불가는 목적지 종류와 무관하게 제자리 대기 문단만."""
    if route.get("mobility") == IMMOBILE_MOBILITY:
        tags = {"shelter", "common"}
    elif route.get("destination_type") == "exit":
        tags = {"exit", "common"}
    elif route.get("destination_type") == "refuge":
        tags = {"refuge", "common"}
    else:
        tags = {"common"}
    if route.get("passes_smoke"):
        tags.add("smoke")
    return frozenset(tags)


def _is_exit_route(route: dict) -> bool:
    return route.get("destination_type") == "exit" and route.get("mobility") != IMMOBILE_MOBILITY


def _paragraph_allowed(entry: dict, tags_allowed: frozenset, exit_route: bool) -> bool:
    tags = set(entry["tags"])
    if not tags or not tags <= tags_allowed:
        return False
    if is_elevator_paragraph(entry["text"]):
        return False
    if not exit_route and any(phrase in entry["text"] for phrase in EXIT_ONLY_PHRASES):
        return False
    return True


# --------------------------------------------------------------------------
# 질의 (결정론적: 이동 상태 · 목적지 종류 · 연기 통과 여부)
# --------------------------------------------------------------------------
def query_key(route: dict) -> tuple:
    return (
        str(route.get("mobility") or ""),
        str(route.get("destination_type") or ""),
        bool(route.get("passes_smoke")),
    )


def build_query(key: tuple) -> str:
    mobility, destination_type, passes_smoke = key
    destination = "shelter" if mobility == IMMOBILE_MOBILITY else destination_type
    parts = [
        MOBILITY_QUERY.get(mobility, ""),
        DESTINATION_QUERY.get(destination, "화재 시 안전하게 대피하는 행동요령"),
    ]
    if passes_smoke:
        parts.append(SMOKE_QUERY)
    return " ".join(p for p in parts if p)


# --------------------------------------------------------------------------
# 유사도 (순수 파이썬)
# --------------------------------------------------------------------------
def _cosine(a: list, a_norm: float, b: list, b_norm: float) -> float:
    if not a_norm or not b_norm or len(a) != len(b):
        return 0.0
    return sum(x * y for x, y in zip(a, b)) / (a_norm * b_norm)


def _bigrams(text: str) -> Counter:
    """한국어는 조사가 붙어 단어 단위 일치가 약하므로, 단어 안의 글자 2-gram 으로 비교한다."""
    grams = Counter()
    for word in _WORD.findall((text or "").lower()):
        if len(word) == 1:
            grams[word] += 1
        else:
            grams.update(word[i:i + 2] for i in range(len(word) - 1))
    return grams


def _counter_cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    dot = sum(count * b.get(gram, 0) for gram, count in a.items())
    if not dot:
        return 0.0
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    return dot / (norm_a * norm_b)


# --------------------------------------------------------------------------
# 인덱스 로드 (모듈 캐시)
# --------------------------------------------------------------------------
_index_lock = threading.Lock()
_index_cache = None  # ((경로, 수정시각), entries)


def _normalize_entry(raw) -> Optional[dict]:
    """인덱스 항목을 검색용으로 정리한다. 형식이 틀린 항목은 버린다."""
    if not isinstance(raw, dict):
        return None
    text = raw.get("text")
    tags = raw.get("tags")
    if not isinstance(text, str) or not text.strip():
        return None
    if not isinstance(tags, list) or not tags or any(t not in VALID_TAGS for t in tags):
        return None

    vector, norm = None, 0.0
    embedding = raw.get("embedding")
    if isinstance(embedding, list) and embedding and all(
        isinstance(x, (int, float)) and not isinstance(x, bool) for x in embedding
    ):
        vector = [float(x) for x in embedding]
        norm = math.sqrt(sum(x * x for x in vector))
        if not norm:
            vector = None

    return {
        "id": str(raw.get("id") or ""),
        "text": text.strip(),
        "tags": list(tags),
        "title": str(raw.get("title") or ""),
        "publisher": str(raw.get("publisher") or ""),
        "url": str(raw.get("url") or ""),
        "_vector": vector,
        "_norm": norm,
        "_bigrams": _bigrams(text),
    }


def load_index(path: Path = INDEX_PATH) -> Optional[list]:
    """manual_index.json 을 읽어 메모리에 캐시한다. 파일이 없거나 깨졌으면 None."""
    global _index_cache
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    cache_key = (str(path), mtime)

    with _index_lock:
        if _index_cache is not None and _index_cache[0] == cache_key:
            return _index_cache[1]
        try:
            # UTF-8 BOM이 붙은 외부 생성 인덱스도 안전하게 읽는다.
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as exc:
            log.warning("매뉴얼 인덱스를 읽지 못함(%s)", type(exc).__name__)
            return None
        entries = [e for e in map(_normalize_entry, raw if isinstance(raw, list) else []) if e]
        _index_cache = (cache_key, entries)
        return entries


# --------------------------------------------------------------------------
# 질의 임베딩 (메모리 캐시)
# --------------------------------------------------------------------------
_query_lock = threading.Lock()
_query_vectors = {}       # query_key -> (vector, norm)
_query_failed_at = {}     # query_key -> 실패 시각(monotonic)


def _embed_query(text: str, timeout: float) -> list:
    """질의 임베딩 1회 호출. 테스트에서 교체할 수 있게 모듈 함수로 둔다."""
    from langchain_openai import OpenAIEmbeddings

    embedder = OpenAIEmbeddings(
        model=EMBEDDING_MODEL,
        timeout=timeout,
        max_retries=0,
        # tiktoken 인코딩 파일을 받느라 첫 요청이 느려지지 않게 길이 검사를 끈다 (질의는 짧다)
        check_embedding_ctx_length=False,
    )
    return embedder.embed_query(text)


def _query_vector(key: tuple):
    """캐시된 질의 벡터를 돌려준다. 키가 없거나 최근 실패했거나 호출이 실패하면 None."""
    if not os.getenv("OPENAI_API_KEY"):
        return None
    with _query_lock:
        if key in _query_vectors:
            return _query_vectors[key]
        failed_at = _query_failed_at.get(key)
        if failed_at is not None and time.monotonic() - failed_at < EMBED_RETRY_AFTER:
            return None

    try:
        vector = [float(x) for x in _embed_query(build_query(key), EMBED_TIMEOUT)]
        norm = math.sqrt(sum(x * x for x in vector))
        if not norm:
            raise ValueError("빈 임베딩")
    except Exception as exc:  # noqa: BLE001 - 임베딩 실패는 키워드 검색으로 대체한다
        log.warning("질의 임베딩 실패(%s) → 키워드 검색으로 대체 [조합=%s]", type(exc).__name__, key)
        with _query_lock:
            _query_failed_at[key] = time.monotonic()
        return None

    with _query_lock:
        _query_vectors[key] = (vector, norm)
        _query_failed_at.pop(key, None)
    return vector, norm


def reset_cache() -> None:
    """인덱스·질의 캐시를 비운다 (테스트·로컬 개발용)."""
    global _index_cache
    with _index_lock:
        _index_cache = None
    with _query_lock:
        _query_vectors.clear()
        _query_failed_at.clear()


# --------------------------------------------------------------------------
# 검색
# --------------------------------------------------------------------------
def _public(entry: dict, score: float, method: str) -> dict:
    return {
        "id": entry["id"],
        "text": entry["text"],
        "tags": list(entry["tags"]),
        "title": entry["title"],
        "publisher": entry["publisher"],
        "url": entry["url"],
        "score": round(score, 4),
        "method": method,
    }


def _search(route: dict, k: int, index) -> tuple:
    if index is None:
        entries = load_index()
        if entries is None:
            return [], "index_unavailable"
    else:
        entries = [e for e in map(_normalize_entry, index) if e]

    exit_route = _is_exit_route(route)
    tags_ok = allowed_tags(route)
    candidates = [e for e in entries if _paragraph_allowed(e, tags_ok, exit_route)]
    if not candidates:
        return [], None

    key = query_key(route)
    scored, method = [], "keyword"

    if any(e["_vector"] for e in candidates):
        query = _query_vector(key)
        if query is not None:
            q_vector, q_norm = query
            scored = [
                (_cosine(q_vector, q_norm, e["_vector"], e["_norm"]), e)
                for e in candidates
                if e["_vector"] is not None and len(e["_vector"]) == len(q_vector)
            ]
            method = "embedding" if scored else "keyword"

    if method == "keyword":
        q_grams = _bigrams(build_query(key))
        scored = [(_counter_cosine(q_grams, e["_bigrams"]), e) for e in candidates]
        scored = [(score, e) for score, e in scored if score > 0]

    scored.sort(key=lambda pair: (-pair[0], pair[1]["id"]))
    results = [_public(e, score, method) for score, e in scored[:k]]
    # 결과 단계에서 한 번 더 제외 (원칙 5)
    return [r for r in results if not is_elevator_paragraph(r["text"])], None


_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="manual-retrieve")


def search_manuals(route: dict, k: int = DEFAULT_K, timeout: float = DEFAULT_TIMEOUT, *, index=None) -> tuple:
    """(문단 목록, 실패 사유 또는 None). 예외를 던지지 않는다.

    실패 사유 예: "index_unavailable", "timeout", "error: KeyError"
    index 를 넘기면 파일 대신 그 목록에서 검색한다 (테스트용).
    """
    try:
        if not isinstance(route, dict) or route.get("status") != "ok" or k <= 0:
            return [], None
        future = _executor.submit(_search, route, k, index)
        return future.result(timeout=timeout)
    except FutureTimeout:
        log.warning("매뉴얼 검색 시간 초과(%.1f초) → 참고 자료 없이 진행", timeout)
        return [], "timeout"
    except Exception as exc:  # noqa: BLE001 - 검색 실패가 안내를 막으면 안 된다
        log.warning("매뉴얼 검색 실패(%s) → 참고 자료 없이 진행", type(exc).__name__)
        return [], f"error: {type(exc).__name__}"


def retrieve(route: dict, k: int = DEFAULT_K, timeout: float = DEFAULT_TIMEOUT, *, index=None) -> list:
    """매뉴얼 문단 최대 k개. 실패하면 빈 목록 (예외 없음)."""
    return search_manuals(route, k, timeout, index=index)[0]
