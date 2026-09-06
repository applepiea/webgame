import json
import os
from backend.services.phases import DEFAULT_PHASES, DEFAULT_GROUP_LIMITS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "../../data")

def get_available_scenarios():
    scenarios = []
    if not os.path.exists(DATA_DIR):
        return scenarios
    
    for folder_name in os.listdir(DATA_DIR):
        folder_path = os.path.join(DATA_DIR, folder_name)
        if os.path.isdir(folder_path):
            info_path = os.path.join(folder_path, "info.json")
            if os.path.exists(info_path):
                with open(info_path, "r", encoding="utf-8") as f:
                    info = json.load(f)
                    scenarios.append({"id": folder_name, **info})
    return scenarios

def load_scenario_characters(scenario_id):
    """특정 시나리오의 characters.json 파일을 로드"""
    char_path = os.path.join(DATA_DIR, scenario_id, "characters.json")
    if os.path.exists(char_path):
        with open(char_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("characters", [])
    return []


# 장소(캐릭터 처소) → 이미지 폴더 슬러그.
# 기존 캐릭터 프로필 이미지 폴더명(dalrae, leegang, leeyoon, moobaek, seolhwa)과 통일.
# ⚠️ 실제 폴더 구조나 이름이 다르면 이 맵만 고치면 됩니다.
LOCATION_SLUG_MAP = {
    "연이의 처소": "yeoni",
    "소주방 (달래)": "dalrae",
    "이강의 처소": "leegang",
    "동궁전 (이윤)": "leeyoon",
    "침방 (설화)": "seolhwa",
    "순찰 초소 (무백)": "moobaek",
}

# 인터뷰 카드의 화자(speaker) 이름 → 이미지 폴더 슬러그
CHARACTER_SLUG_MAP = {
    "연이": "yeoni",
    "달래": "dalrae",
    "이강": "leegang",
    "이윤": "leeyoon",
    "설화": "seolhwa",
    "무백": "moobaek",
}

# 카드 종류(type) → 파일명 슬러그
TYPE_SLUG_MAP = {
    "설정": "seoljeong",
    "증언": "jeungeon",
    "증거": "jeunggeo",
    "소지품": "sojipum",
    "물증": "muljeung",
    "허탕": "heotang",
    "핵심물증": "core_muljeung",
    "인터뷰": "interview",
}


def _location_slug(location):
    return LOCATION_SLUG_MAP.get(location, "unknown")


def _character_slug(name):
    return CHARACTER_SLUG_MAP.get(name, "unknown")


def _type_slug(card_type):
    return TYPE_SLUG_MAP.get(card_type, "etc")


def load_scenario_objects(scenario_id):
    """시나리오의 objects.json(location_cards / naewoldang_cards / interview_cards)을
    보드에서 주울 수 있는 오브젝트 통합 스키마 딕셔너리(id → object)로 변환해서 반환.
    """
    obj_path = os.path.join(DATA_DIR, scenario_id, "objects.json")
    if not os.path.exists(obj_path):
        return {}

    with open(obj_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    objects = {}
    character_list = load_scenario_characters(scenario_id)

    # 1. 장소 카드 (location_cards) — 캐릭터 처소별 설정/소지품 5개씩
    for card in raw.get("location_cards", []):
        loc_slug = _location_slug(card["location"])
        type_slug = _type_slug(card["type"])
        back_image = _resolve_location_owner_image(scenario_id, card["location"], character_list)
        objects[card["id"]] = {
            "id": card["id"],
            "group": "location",
            "character_location": card["location"],  # 연이의 처소 / 소주방 (달래) 등
            "location": None,
            "character_interview": None,
            "type": card["type"],
            "speaker": None,
            "target": None,
            "content": card["content"],
            "front_image": f"/data/{scenario_id}/images/objects/{loc_slug}_{type_slug}.png",
            "back_image": back_image,
            "revealed": False,
            "owner": None,
            "viewed": False,
            "claimed_phase": None,
        }

    # 2. 내월당 카드 (naewoldang_cards) — location 필드에 외당/내당 구분값 저장
    naewoldang = raw.get("naewoldang_cards", {})
    area_label = {"outer": "외당", "inner": "내당"}
    for area in ("outer", "inner"):
        for card in naewoldang.get(area, []):
            type_slug = _type_slug(card["type"])
            objects[card["id"]] = {
                "id": card["id"],
                "group": "naewoldang",
                "character_location": None,
                "location": area_label[area],  # "외당" | "내당"
                "character_interview": None,
                "type": card["type"],
                "speaker": None,
                "target": None,
                "content": card["content"],
                "front_image": f"/data/{scenario_id}/images/objects/naewoldang_{area}_{type_slug}.png",
                "back_image": f"/data/{scenario_id}/images/objects/naewoldang_{area}_{type_slug}_back.png",
                "revealed": False,
                "owner": None,
                "viewed": False,
                "claimed_phase": None,
            }

    # 3. 인터뷰 카드 (interview_cards) — character_interview 필드에 화자 이름 저장
    #    원본에 id가 없어서 앞선 카드들 다음 번호부터 이어서 부여
    #    이미지는 그 인터뷰가 "누구에 대한 것인지"(target) 캐릭터 사진을 사용 (스님처럼 플레이 캐릭터가 아니면 monk.png)
    next_id = max(objects.keys(), default=0) + 1
    for card in raw.get("interview_cards", []):
        target_image = _resolve_interview_target_image(scenario_id, card["target"], character_list)
        objects[next_id] = {
            "id": next_id,
            "group": "interview",
            "character_location": None,
            "location": None,
            "character_interview": card["speaker"],  # 이 카드가 속한 화자 캐릭터
            "type": "인터뷰",
            "speaker": card["speaker"],
            "target": card["target"],
            "content": card["content"],
            "front_image": target_image,
            "back_image": target_image,
            "revealed": False,
            "owner": None,
            "viewed": False,
            "claimed_phase": None,
        }
        next_id += 1

    return objects


def _character_sheet_pages(data):
    """캐릭터 설정집 전용 구조를 페이지로 변환:
      {"name":..., "role":..., "warning":..., "narrative":[...], "timeline":[{"time","event"}], "goals":[...]}
    구조가 안 맞으면 (None, None)을 반환.
    """
    if not isinstance(data, dict) or "name" not in data:
        return None, None
    if not any(key in data for key in ("narrative", "timeline", "goals", "rule")):
        return None, None

    name = data.get("name") or ""
    role = data.get("role")
    warning = data.get("warning")
    title = f"{name} 설정집" if name else None

    pages = []

    # 개요 페이지 (역할/경고 문구가 있을 때만)
    intro_lines = []
    if role:
        intro_lines.append(f"역할: {role}")
    if warning:
        intro_lines.append(f"⚠ {warning}")
    if intro_lines:
        pages.append({"heading": "개요", "body": "\n".join(intro_lines)})

    # 서사(narrative) - 문단마다 한 페이지씩
    narrative = data.get("narrative")
    if isinstance(narrative, list):
        total = len(narrative)
        for i, para in enumerate(narrative, start=1):
            pages.append({"heading": f"이야기 {i}/{total}", "body": str(para)})
    elif isinstance(narrative, str) and narrative:
        pages.append({"heading": "이야기", "body": narrative})

    # 타임라인 - 프론트에서 전용 UI로 렌더링할 수 있도록 구조 그대로 전달
    timeline = data.get("timeline")
    if isinstance(timeline, list) and timeline:
        entries = []
        for entry in timeline:
            if isinstance(entry, dict):
                entries.append({"time": str(entry.get("time", "")), "event": str(entry.get("event", ""))})
            else:
                entries.append({"time": "", "event": str(entry)})
        pages.append({"heading": "그날의 행적", "type": "timeline", "entries": entries, "body": ""})

    # 목표
    goals = data.get("goals")
    if isinstance(goals, list) and goals:
        pages.append({"heading": "목표", "body": "\n".join(f"· {g}" for g in goals)})
    elif isinstance(goals, str) and goals:
        pages.append({"heading": "목표", "body": goals})

    # 캐릭터 고유 능력/규칙
    rule = data.get("rule")
    if isinstance(rule, str) and rule:
        pages.append({"heading": "🎴 고유 능력", "body": rule})

    if not pages:
        return None, None

    return title, pages


def _stringify_value(value, indent=0):
    """dict/list가 섞인 값을 사람이 읽기 좋은 텍스트로 변환 (룰북 파서용 헬퍼)"""
    prefix = "  " * indent
    if isinstance(value, list):
        lines = []
        for item in value:
            if isinstance(item, dict):
                lines.append(_stringify_value(item, indent))
            else:
                lines.append(f"{prefix}· {item}")
        return "\n".join(lines)
    if isinstance(value, dict):
        lines = []
        for k, v in value.items():
            if isinstance(v, (list, dict)):
                lines.append(f"{prefix}{k}:")
                lines.append(_stringify_value(v, indent + 1))
            else:
                lines.append(f"{prefix}{k}: {v}")
        return "\n".join(lines)
    return f"{prefix}{value}"


def _rulebook_pages(data):
    """진행 설명서(rulebook.json) 전용 구조를 페이지로 변환:
      {"title":..., "overview": {...}, "schedule": [...], "rules": {섹션별 규칙}}
    구조가 안 맞으면 (None, None)을 반환.
    """
    if not isinstance(data, dict) or "schedule" not in data or "rules" not in data:
        return None, None

    title = data.get("title") or "게임 진행 설명서"
    pages = []

    overview = data.get("overview")
    if isinstance(overview, dict) and overview:
        pages.append({"heading": "개요", "body": _stringify_value(overview)})

    schedule = data.get("schedule")
    if isinstance(schedule, list) and schedule:
        lines = []
        for entry in schedule:
            if not isinstance(entry, dict):
                continue
            step = entry.get("step", "")
            name = entry.get("name", "")
            duration = entry.get("duration")
            content = entry.get("content", "")
            duration_text = f" ({duration})" if duration else ""
            lines.append(f"{step}. {name}{duration_text}\n{content}")
        pages.append({"heading": "진행 순서", "body": "\n\n".join(lines)})

    rules = data.get("rules")
    if isinstance(rules, dict):
        for key, section in rules.items():
            if not isinstance(section, dict):
                continue
            heading = section.get("title", key)
            body_parts = []
            for field_key, field_value in section.items():
                if field_key == "title":
                    continue
                if isinstance(field_value, (list, dict)):
                    stringified = _stringify_value(field_value)
                else:
                    stringified = f"{field_key}: {field_value}"
                if stringified:
                    body_parts.append(stringified)
            pages.append({"heading": heading, "body": "\n\n".join(body_parts)})

    if not pages:
        return None, None

    return title, pages


def _structure_pages(data):
    """다음 형태들을 프론트에서 바로 페이지로 쓸 수 있는 (title, [{heading, body}, ...])로 변환:
      0) {"name":..., "narrative":[...], "timeline":[...], "goals":[...]}     ← 캐릭터 설정집 전용 구조
      0-1) {"schedule": [...], "rules": {...}}                               ← 진행 설명서(rulebook.json) 전용 구조
      1) {"title": "...", "sections": [{"heading":..., "content": [...]}]}  ← info.json 형태
      2) [{"heading":..., "content": [...]}]                                ← title 없이 리스트만
      3) {"이름": "...", "비밀": "...", ...} 같은 플랫한 키-값 딕셔너리       ← 그 외 일반 딕셔너리
    구조가 완전히 안 맞으면 (None, None)을 반환 (호출부에서 원본 JSON을 그대로 문자열로 덤프하는 fallback을 씀).
    """
    # 형태 0: 캐릭터 설정집 전용 구조 (최우선으로 체크)
    sheet_title, sheet_pages = _character_sheet_pages(data)
    if sheet_pages is not None:
        return sheet_title, sheet_pages

    # 형태 0-1: 진행 설명서(rulebook.json) 전용 구조
    rulebook_title, rulebook_pages = _rulebook_pages(data)
    if rulebook_pages is not None:
        return rulebook_title, rulebook_pages

    title = None
    section_list = data

    if isinstance(data, dict):
        title = data.get("title")
        section_list = data.get("sections", data.get("content"))

    # 형태 1, 2: heading/content 리스트
    if isinstance(section_list, list) and all(isinstance(item, dict) and "heading" in item and "content" in item for item in section_list):
        pages = []
        for section in section_list:
            raw_content = section.get("content")
            if isinstance(raw_content, list):
                body = "\n\n".join(str(p) for p in raw_content)
            else:
                body = str(raw_content)
            pages.append({"heading": str(section.get("heading", "")), "body": body})
        return title, pages

    # 형태 3: 플랫한 키-값 딕셔너리 → 각 키를 한 페이지로
    if isinstance(data, dict):
        pages = []
        for key, value in data.items():
            if key in ("title", "sections"):
                continue
            if value is None:
                continue
            if isinstance(value, list):
                body = "\n\n".join(str(v) for v in value)
            elif isinstance(value, dict):
                body = "\n".join(f"{k}: {v}" for k, v in value.items())
            else:
                body = str(value)
            pages.append({"heading": str(key), "body": body})
        if pages:
            return title, pages

    return None, None


def _build_content_field(data):
    """구조화된 heading/content 리스트(또는 title+sections)면 (제목, 페이지 배열)을,
    구조가 안 맞으면 (None, 예쁘게 들여쓴 JSON 문자열)을 반환"""
    title, pages = _structure_pages(data)
    if pages is not None:
        return title, pages
    return None, json.dumps(data, ensure_ascii=False, indent=2)


def _build_rulebook_content(data):
    """rules.json 전용 포맷터. info.json류의 {title, sections} 구조와 달라서
    _build_content_field로는 매칭이 안 되고 날것 JSON이 그대로 노출되던 문제를 해결하기 위해
    필드별로 직접 읽어서 사람이 읽기 좋은 페이지 배열로 구성함."""
    title = data.get("title") or "게임 규칙"
    pages = []

    overview = data.get("overview")
    if overview:
        lines = []
        if overview.get("player_count"):
            lines.append(f"인원: {overview['player_count']}명")
        if overview.get("characters"):
            lines.append(f"캐릭터: {', '.join(overview['characters'])}")
        if overview.get("total_duration"):
            lines.append(f"총 소요 시간: {overview['total_duration']}")
        if overview.get("facilitation"):
            lines.append(f"진행 방식: {overview['facilitation']}")
        pages.append({"heading": "개요", "body": "\n".join(lines)})

    schedule = data.get("schedule")
    if schedule:
        lines = []
        for step in schedule:
            duration = f" ({step['duration']})" if step.get("duration") else ""
            lines.append(f"{step.get('step', '')}. {step.get('name', '')}{duration}\n   {step.get('content', '')}")
        pages.append({"heading": "진행 순서", "body": "\n\n".join(lines)})

    rules = data.get("rules") or {}
    for section in rules.values():
        if not isinstance(section, dict):
            continue
        heading = section.get("title") or "규칙"
        parts = []
        if section.get("points"):
            parts.append("\n".join(f"· {p}" for p in section["points"]))
        if section.get("investigation_slots"):
            slots = section["investigation_slots"]
            slot_line = ", ".join(f"{k}: {v}개" for k, v in slots.items())
            parts.append(f"조사 시간별 단서 개수 — {slot_line}")
        if section.get("submission_rule"):
            parts.append(section["submission_rule"])
        if section.get("side_talk"):
            parts.append(section["side_talk"])
        if section.get("voting"):
            voting = section["voting"]
            if voting.get("method"):
                parts.append(f"투표 방식: {voting['method']}")
            if voting.get("resolution"):
                parts.append(f"판정: {voting['resolution']}")
        if parts:
            pages.append({"heading": heading, "body": "\n\n".join(parts)})

    if data.get("total_time_summary"):
        pages.append({"heading": "총 소요 시간", "body": data["total_time_summary"]})

    if not pages:
        # 예상한 구조가 전혀 안 맞으면 그래도 날것 JSON 대신 최소한의 안내만 표시
        pages = [{"heading": title, "body": "규칙 내용을 불러오지 못했습니다. rules.json 형식을 확인해주세요."}]

    return title, pages


def load_scenario_info(scenario_id):
    """시나리오 폴더의 info.json을 로드 (전 참여자 공통 기본 자료)"""
    info_path = os.path.join(DATA_DIR, scenario_id, "info.json")
    if os.path.exists(info_path):
        with open(info_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def load_scenario_phase_config(scenario_id):
    """시나리오 폴더의 phases.json에서 페이즈 구성(이름/시간/조사여부/획득한도)과
    오브젝트 그룹별 획득 제한 규칙(group_limits)을 로드.
    파일이 없으면 phases.py의 최소 기본값으로 대체.

    phases.json 형식 예시:
    {
      "phases": [
        {"name": "설정 읽는 시간", "duration_min": 10, "note": null, "is_investigation": false, "claim_limit": null},
        {"name": "첫 번째 조사 시간", "duration_min": 25, "note": "단서 네 개, 밀담 포함", "is_investigation": true, "claim_limit": 4}
      ],
      "group_limits": [
        {"group": "naewoldang", "per_investigation_phase": 1, "total": 3}
      ]
    }
    """
    config_path = os.path.join(DATA_DIR, scenario_id, "phases.json")
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        phases = data.get("phases") or DEFAULT_PHASES
        group_limits = data.get("group_limits", DEFAULT_GROUP_LIMITS)
        return phases, group_limits
    return DEFAULT_PHASES, DEFAULT_GROUP_LIMITS


def load_scenario_special_items(scenario_id):
    """시나리오 폴더의 special_items.json에서 특정 오브젝트 id에 대한 특별 규칙을 로드.
    이 시나리오에만 있는 예외 규칙(완전 양도 가능 여부, 특정 페이즈에 특정 캐릭터만 획득 가능 등)을
    코드 수정 없이 데이터로 정의하기 위한 용도. 파일이 없으면 빈 딕셔너리(특별 규칙 없음).

    special_items.json 형식 예시:
    {
      "37": {
        "transferable": true,                     // 밀담 중 상대에게 소유권을 완전히 넘길 수 있음
        "exclusive_character": "연이",              // 아래 exclusive_phase에서 지정한 페이즈엔 이 캐릭터만 획득 가능 (그 외엔 잠김)
        "exclusive_phase": 2                        // 몇 페이즈에 적용할지 (1=설정 읽는 시간, 2=첫 번째 조사 시간 ...)
      }
    }
    """
    path = os.path.join(DATA_DIR, scenario_id, "special_items.json")
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    # JSON 키는 항상 문자열이라 오브젝트 id(int)로 변환
    return {int(k): v for k, v in raw.items()}


def load_scenario_special_ability_config(scenario_id):
    """시나리오 폴더의 special_ability_config.json을 로드.
    이 시나리오에만 있는 캐릭터 전용 특수 능력(예: 심문 - 특정 캐릭터가 조사 시간마다 GM 승인 하에
    강제 밀담을 거는 능력)을 코드 수정 없이 데이터로 켜고 끌 수 있도록 하기 위한 용도.
    파일이 없으면 None (해당 시나리오엔 이 기능 자체가 없음).

    "틀"(공용 기본 문구)은 시나리오 폴더가 아니라 data/special_ability_config.default.json에
    모든 시나리오가 공유하는 형태로 따로 두고, 여기서 로드하는 건 이 시나리오만의 실제 값(캐릭터명/대사)임.
    프론트(game.js)에서 그 공용 틀과 이 값을 합쳐서 최종적으로 사용함.

    special_ability_config.json 형식 예시:
    {
      "ability_character": "이윤",
      "accept_message": "...",
      "reject_message": "..."
    }
    """
    path = os.path.join(DATA_DIR, scenario_id, "special_ability_config.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_scenario_ending_visual_theme(scenario_id):
    """endings.json 최상단의 visual_theme 값만 로드 (예: "joseon_scroll").
    엔딩 '내용' 자체는 스포일러라 room_data 밖으로 안 나가지만, 이 값은 그냥 모달 겉모습(CSS 테마) 선택용이라
    스포일러가 아니므로 game_state에 바로 넣어서 누구나(엔딩 발표 전에도) 알 수 있게 해도 무방함.
    값이 없거나 파일 자체가 없으면 None → 프론트에서 기본(수수한 카드형) 테마로 처리."""
    path = os.path.join(DATA_DIR, scenario_id, "endings.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("visual_theme")


def load_scenario_ending_rules_config(scenario_id):
    """endings.json 최상단의 form_fields(GM 판정 입력 폼을 어떻게 그릴지)와
    rules(판정값 → 엔딩 id로 매핑하는 규칙, 위에서부터 순서대로 검사해 처음 맞는 것을 씀)를 로드.
    이 시나리오만의 엔딩 분기 로직 전체가 여기 담겨있어서, ending_handler.py는 이 시나리오가
    "이강"이니 "구미호"니 하는 걸 전혀 몰라도 됨 - 그냥 규칙을 순서대로 비교하는 범용 엔진만 가짐.

    폼 필드 스펙 자체는 스포일러가 아니지만(어떤 입력을 받는지일 뿐, 엔딩 내용은 아님) 그래도
    GM 전용으로만 취급 - 참여자에게 굳이 노출할 이유가 없어서 room_data에만 두고 game_state엔 안 넣음.
    파일이 없거나 form_fields/rules 자체가 없으면 빈 값 반환 (그 시나리오는 자동 판정 기능 없음,
    GM이 "직접 목록에서 고르기"로 수동 선택해야 함)."""
    path = os.path.join(DATA_DIR, scenario_id, "endings.json")
    if not os.path.exists(path):
        return {"form_fields": [], "rules": []}
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "form_fields": data.get("form_fields", []),
        "rules": data.get("rules", []),
    }


def load_scenario_endings(scenario_id):
    """시나리오 폴더의 endings.json에서 엔딩 목록을 로드.
    발표 전까지 절대 스포일러가 새어나가면 안 되므로, 이 데이터는 room_data(game_state 밖)에만
    보관하고 GM이 실제로 엔딩을 발표(reveal_ending)하기 전까지는 절대 방 전체로 브로드캐스트하지 않음.

    endings.json 형식 예시:
    {
      "endings": [
        {
          "id": "ending_fox_yeoni",
          "title": "여우의 진실",
          "image": "endings/ending_fox_yeoni.png",
          "content": [
            {"heading": "...", "content": ["문단1", "문단2"]}
          ]
        }
      ]
    }
    content은 info.json/캐릭터 설정집과 동일하게 _build_content_field()로 파싱 가능한 구조를 그대로 써도 됨.
    파일이 없으면 빈 리스트.
    """
    path = os.path.join(DATA_DIR, scenario_id, "endings.json")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    endings = data.get("endings", [])
    result = []
    for ending in endings:
        title, content = _build_content_field({"title": ending.get("title"), "sections": ending.get("content")}) \
            if isinstance(ending.get("content"), list) and ending.get("content") and isinstance(ending["content"][0], dict) \
            else (ending.get("title"), ending.get("content", ""))
        result.append({
            "id": ending.get("id"),
            "title": title or ending.get("title"),
            "image": ending.get("image"),
            "content": content,
            "theme_track": ending.get("theme_track"),
        })
    return result


def _resolve_character_image_path(scenario_id, image_field):
    """characters.json의 image 필드 값을 실제 웹 경로로 변환.
    프론트엔드 utils.js의 getCharacterImageUrl()과 동일한 규칙을 백엔드에서도 따름."""
    if not image_field:
        return "/data/default_avatar.png"
    if image_field.startswith("http") or image_field.startswith("/data"):
        return image_field
    clean_path = image_field if image_field.startswith("/") else f"/{image_field}"
    if "images" not in clean_path and "character" not in clean_path:
        return f"/data/{scenario_id}/images/character{clean_path}"
    return f"/data/{scenario_id}{clean_path}"


def _resolve_interview_target_image(scenario_id, target_name, character_list):
    """인터뷰 카드의 target(그 인터뷰가 누구에 대한 것인지)에 해당하는 캐릭터 사진 경로를 반환.
    스님처럼 플레이 캐릭터가 아니라 characters.json에 없는 이름이면, 같은 캐릭터 이미지 폴더의
    monk.png를 사용 (다른 캐릭터들과 동일한 /images/character/ 경로 규칙)."""
    matched = next((c for c in character_list if c.get("name") == target_name), None)
    if matched is not None:
        return _resolve_character_image_path(scenario_id, matched.get("image"))
    return f"/data/{scenario_id}/images/character/monk.png"


def _resolve_location_owner_image(scenario_id, location_label, character_list):
    """장소 카드의 character_location 문자열(예: "연이의 처소", "소주방 (달래)")에
    어느 캐릭터 이름이 포함돼 있는지 찾아서 그 캐릭터의 사진 경로를 반환.
    매칭되는 캐릭터가 없으면(예상 밖 장소명) 기본 아바타로 대체."""
    for character in character_list:
        name = character.get("name")
        if name and name in (location_label or ""):
            return _resolve_character_image_path(scenario_id, character.get("image"))
    return "/data/default_avatar.png"


def load_character_sheet(scenario_id, character_name):
    """sheets/ 폴더에서 캐릭터 이름과 매칭되는 설정집 json을 찾아 로드
    (파일명에 캐릭터 슬러그가 포함되어 있다고 가정: 예) 01_yeoni.json)"""
    sheets_dir = os.path.join(DATA_DIR, scenario_id, "sheets")
    if not os.path.isdir(sheets_dir):
        return None

    slug = _character_slug(character_name)
    for filename in os.listdir(sheets_dir):
        if filename.lower().endswith(".json") and slug in filename.lower():
            with open(os.path.join(sheets_dir, filename), "r", encoding="utf-8") as f:
                return json.load(f)
    return None


def load_scenario_map_path(scenario_id):
    """시나리오 폴더의 images/ 안에서 지도 이미지 파일을 찾아 웹 경로로 반환 (없으면 None)
    map.png, map.jpg, map.jpeg 중 하나를 지원"""
    for filename in ("map.png", "map.jpg", "map.jpeg"):
        full_path = os.path.join(DATA_DIR, scenario_id, "images", filename)
        if os.path.exists(full_path):
            return f"/data/{scenario_id}/images/{filename}"
    return None


def load_scenario_rulebook(scenario_id):
    """시나리오 폴더의 rulebook.json을 로드 (info.json과 동일한 구조 지원)"""
    path = os.path.join(DATA_DIR, scenario_id, "rulebook.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def build_default_inventory_items(scenario_id, nickname, character_name, next_id, include_sheet=True, include_map=True, include_rulebook=True):
    """게임 시작 시 각 참여자(또는 GM)에게 기본으로 지급되는 인벤토리 아이템 생성.
    시나리오 정보는 항상 포함, 캐릭터 설정집/지도/룰북은 각각 include_* 플래그로 켜고 끌 수 있음
    (예: GM은 캐릭터가 없어서 설정집/지도는 빼고 시나리오 정보+룰북만 받을 수 있음).
    반환값: (새로 생성된 오브젝트 딕셔너리, 다음에 쓸 id)
    """
    items = {}

    info_data = load_scenario_info(scenario_id)
    if info_data is not None:
        info_title, info_content = _build_content_field(info_data)
        items[next_id] = {
            "id": next_id,
            "group": "default_info",
            "character_location": None,
            "location": None,
            "character_interview": None,
            "type": "시나리오 정보",
            "speaker": None,
            "target": None,
            "doc_title": info_title,
            "content": info_content,
            "front_image": f"/data/{scenario_id}/images/bg.png",
            "back_image": f"/data/{scenario_id}/images/bg.png",
            "revealed": True,
            "owner": nickname,
        }
        next_id += 1

    sheet_data = load_character_sheet(scenario_id, character_name) if include_sheet else None
    if sheet_data is not None:
        sheet_title, sheet_content = _build_content_field(sheet_data)

        # 앞면/뒷면(표지+인벤토리 썸네일) 둘 다 = 캐릭터 선택 화면에서 쓰던 그 캐릭터 사진
        character_list = load_scenario_characters(scenario_id)
        matched_character = next((c for c in character_list if c.get("name") == character_name), None)
        char_image_field = matched_character.get("image") if matched_character else None
        sheet_character_image = _resolve_character_image_path(scenario_id, char_image_field)

        items[next_id] = {
            "id": next_id,
            "group": "default_sheet",
            "character_location": None,
            "location": None,
            "character_interview": None,
            "type": "캐릭터 설정집",
            "speaker": character_name,
            "target": None,
            "doc_title": sheet_title or f"{character_name} 설정집",
            "content": sheet_content,
            "front_image": sheet_character_image,
            "back_image": sheet_character_image,
            "revealed": True,
            "owner": nickname,
        }
        next_id += 1

    # 지도 - 텍스트 페이지 없이 이미지 자체가 콘텐츠
    map_path = load_scenario_map_path(scenario_id) if include_map else None
    if map_path is not None:
        items[next_id] = {
            "id": next_id,
            "group": "default_map",
            "character_location": None,
            "location": None,
            "character_interview": None,
            "type": "지도",
            "speaker": None,
            "target": None,
            "doc_title": "지도",
            "content": [],  # 별도 텍스트 없음 - 이미지만 보여줌
            "front_image": map_path,
            "back_image": map_path,
            "revealed": True,
            "owner": nickname,
        }
        next_id += 1

    # 룰북 - rules.json 전용 포맷터로 필드별 구조화 (날것 JSON 노출 방지)
    rulebook_data = load_scenario_rulebook(scenario_id) if include_rulebook else None
    if rulebook_data is not None:
        rb_title, rb_content = _build_rulebook_content(rulebook_data)
        items[next_id] = {
            "id": next_id,
            "group": "default_rulebook",
            "character_location": None,
            "location": None,
            "character_interview": None,
            "type": "룰북",
            "speaker": None,
            "target": None,
            "doc_title": rb_title or "게임 규칙",
            "content": rb_content,
            "front_image": f"/data/{scenario_id}/images/bg.png",
            "back_image": f"/data/{scenario_id}/images/bg.png",
            "revealed": True,
            "owner": nickname,
        }
        next_id += 1

    return items, next_id