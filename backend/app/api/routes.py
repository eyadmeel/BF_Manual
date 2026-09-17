"""REST API 엔드포인트."""

import os

from flask import Blueprint, jsonify, request

from ..services import graph_loader as gl
from ..services import help_message, guide_agent
from ..services.mobility import get_profile, list_profiles
from ..services.pathfinder import find_route

bp = Blueprint("api", __name__, url_prefix="/api")


@bp.get("/health")
def health():
    return jsonify({"status": "ok"})


# @bp.get("/config")
# def config():
#     """프론트엔드에서 사용할 공개 설정값만 반환한다."""
#     return jsonify({
#         "kakao_javascript_key": os.getenv("KAKAO_JS_KEY")
#         or os.getenv("KAKAO_JAVA_SCRIPT", "")
#     })

@bp.get("/config")
def config():
    return jsonify({
        "kakao_javascript_key": os.getenv("KAKAO_JS_KEY", "")
    })

@bp.get("/building")
def building():
    """평면도 렌더링용 노드/엣지/층 정보."""
    return jsonify(gl.get_building())


@bp.get("/mobility")
def mobility():
    return jsonify(list_profiles())


@bp.get("/scenarios")
def scenarios():
    data = gl.get_scenarios()
    known_nodes = gl.node_index()

    def origin_node_id(scenario):
        """사람용 origin 문구의 첫 토큰이 실제 노드 ID이면 함께 반환한다."""
        origin = str(scenario.get("origin") or "").strip()
        candidate = origin.split(maxsplit=1)[0] if origin else ""
        return candidate if candidate in known_nodes else None

    return jsonify(
        [
            {
                "key": k,
                "name": v["name"],
                "origin": v.get("origin"),
                "origin_node": origin_node_id(v),
                "blocked_nodes": list(v.get("blocked_nodes", [])),
                "smoke_nodes": list(v.get("smoke_nodes", [])),
                "events": [{"id": e["id"], "label": e["label"]} for e in v.get("events", [])],
            }
            for k, v in data.items()
        ]
    )


@bp.post("/route")
def route():
    """경로 계산. 입력: mobility, start_node, scenario, events[]"""
    body = request.get_json(silent=True) or {}
    profile = get_profile(body.get("mobility"))
    scenario = gl.get_scenario(body.get("scenario", "demo-1"))
    hazard = gl.apply_events(scenario, body.get("events", []))

    try:
        result = find_route(body.get("start_node"), profile, hazard)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


@bp.post("/guide")
def guide():
    """계산된 경로를 행동요령 문장으로 변환. 프론트는 경로를 먼저 그린 뒤 이걸 호출."""
    body = request.get_json(silent=True) or {}
    route_result = body.get("route")
    if not route_result:
        return jsonify({"error": "route 결과가 필요합니다."}), 400
    return jsonify(guide_agent.generate_guide(route_result))


@bp.post("/reroute")
def reroute():
    """이동 중 위험 발생 → 현재 노드 기준 재탐색."""
    body = request.get_json(silent=True) or {}
    profile = get_profile(body.get("mobility"))
    scenario = gl.get_scenario(body.get("scenario", "demo-1"))
    hazard = gl.apply_events(scenario, body.get("events", []))

    try:
        result = find_route(body.get("current_node"), profile, hazard)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    result["rerouted"] = True
    return jsonify(result)


@bp.post("/help-message")
def help_msg():
    body = request.get_json(silent=True) or {}
    route_result = body.get("route")
    if not route_result:
        return jsonify({"error": "route 결과가 필요합니다."}), 400
    return jsonify(help_message.build(route_result, body.get("note", "")))


@bp.post("/dev/reload")
def dev_reload():
    """JSON 수정 후 캐시 비우기(개발용)."""
    gl.reload_all()
    return jsonify({"reloaded": True})
