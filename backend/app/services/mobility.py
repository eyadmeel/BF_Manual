"""이동 가능 여부(mobility) 프로파일 정의.

BF Manual의 차별점이 실제 코드로 구현되는 지점.
계단 통행 가능 여부에 따라 '목적지 종류'가 갈린다.
  - 계단 이용 가능  -> 1층 비상구(exit)
  - 계단 이용 불가  -> 같은 층 방화구획 대피공간(refuge)
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class MobilityProfile:
    key: str
    label: str
    can_use_stairs: bool
    allow_step: bool          # 단차 통과 가능 여부
    min_width: int            # 필요한 최소 유효폭(cm)
    speed_mps: float          # 평균 이동 속도(m/s) - 예상 소요시간 계산용
    edge_penalty: dict = field(default_factory=dict)  # kind별 비용 가중치

    @property
    def destination_types(self) -> tuple:
        return ("exit",) if self.can_use_stairs else ("refuge",)


PROFILES = {
    "independent": MobilityProfile(
        key="independent",
        label="혼자 이동 가능",
        can_use_stairs=True,
        allow_step=True,
        min_width=0,
        speed_mps=1.2,
        edge_penalty={},
    ),
    "walking_aid": MobilityProfile(
        key="walking_aid",
        label="보행 보조기구 사용",
        can_use_stairs=True,
        allow_step=False,
        min_width=80,
        speed_mps=0.6,
        # 계단은 통과 가능하지만 비용을 크게 잡아 가급적 피하게 한다
        edge_penalty={"stair": 3.0, "fire_door": 0.9},
    ),
    "wheelchair": MobilityProfile(
        key="wheelchair",
        label="휠체어 이용",
        can_use_stairs=False,
        allow_step=False,
        min_width=90,
        speed_mps=0.8,
        edge_penalty={"fire_door": 0.9},
    ),
    "need_help": MobilityProfile(
        key="need_help",
        label="이동 불가",
        can_use_stairs=False,
        allow_step=False,
        min_width=0,
        speed_mps=0.5,
        edge_penalty={},
    ),
}

DEFAULT_PROFILE = "independent"


def get_profile(key: str) -> MobilityProfile:
    return PROFILES.get(key or DEFAULT_PROFILE, PROFILES[DEFAULT_PROFILE])


def list_profiles() -> list:
    return [
        {
            "key": p.key,
            "label": p.label,
            "destination_type": p.destination_types[0],
        }
        for p in PROFILES.values()
    ]
