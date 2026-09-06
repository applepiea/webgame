# 시나리오 폴더에 phases.json이 없을 때만 사용하는 최소 기본값.
# 실제 페이즈 구성(개수/시간/단서 개수/순서)은 각 시나리오 폴더의 phases.json에서 정의함.
DEFAULT_PHASES = [
    {"name": "게임 진행", "duration_min": None, "note": None, "is_investigation": True, "claim_limit": None},
]

# 오브젝트 그룹별 획득 제한 규칙의 기본값 (특정 시나리오에만 있는 규칙은 phases.json에서 정의)
DEFAULT_GROUP_LIMITS = []


def is_investigation_phase(phases, phase_number):
    """phases: 방(room)의 game_state.phases 리스트를 그대로 넘겨서 판단"""
    idx = phase_number - 1
    if 0 <= idx < len(phases):
        return bool(phases[idx].get("is_investigation"))
    return False


def investigation_limit(phases, phase_number):
    idx = phase_number - 1
    if 0 <= idx < len(phases):
        return phases[idx].get("claim_limit")
    return None