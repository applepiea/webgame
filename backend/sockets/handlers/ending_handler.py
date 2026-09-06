from .room_handler import rooms, sid_to_room
from backend.logging_setup import get_logger
import os
import json
import datetime

logger = get_logger(__name__)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "..", "..", "..", "data")


def _rule_condition_matches(field_key, expected, values):
  """규칙 조건 하나를 판정값(values)과 비교. field_key에 __gte/__lte/__in 접미사가 붙으면
  그에 맞는 비교 연산을 하고, 접미사가 없으면 정확히 같은 값인지(등호)를 비교함."""
  for suffix, op in (("__gte", "gte"), ("__lte", "lte"), ("__in", "in")):
    if field_key.endswith(suffix):
      field = field_key[: -len(suffix)]
      actual = values.get(field)
      if op == "in":
        return actual in expected
      try:
        actual_num, expected_num = float(actual), float(expected)
      except (TypeError, ValueError):
        return False
      return actual_num >= expected_num if op == "gte" else actual_num <= expected_num
  return values.get(field_key) == expected


def _rule_matches(when, values):
  return all(_rule_condition_matches(k, v, values) for k, v in (when or {}).items())


def evaluate_ending_rules(rules, values):
  """rules를 위에서부터 순서대로 검사해서, 조건(when)이 전부 맞는 첫 번째 규칙의 result(엔딩 id)를 반환.
  맞는 규칙이 하나도 없으면 None. 이 함수는 어떤 시나리오의 규칙이 오든 그대로 처리하는 범용 엔진이라,
  "이강"이니 "구미호"니 하는 이 시나리오만의 개념을 전혀 몰라도 됨 - 그건 전부 endings.json 쪽 데이터임."""
  for rule in rules or []:
    if _rule_matches(rule.get("when"), values):
      return rule.get("result")
  return None


def _playthroughs_path(scenario_id):
  return os.path.join(DATA_DIR, scenario_id, "playthroughs.json")


def _load_playthroughs(scenario_id):
  path = _playthroughs_path(scenario_id)
  if not os.path.exists(path):
    return []
  try:
    with open(path, "r", encoding="utf-8") as f:
      content = f.read().strip()
    if not content:
      return []  # 파일은 있지만 내용이 비어있는 경우(사람이 직접 지운 경우 등) - 정상 취급
    data = json.loads(content)
    return data if isinstance(data, list) else []
  except (json.JSONDecodeError, OSError) as e:
    logger.warning(f"⚠️ [_load_playthroughs] {path} 읽기 실패, 빈 목록으로 처리: {e}")
    return []


def _append_playthrough(scenario_id, record):
  """한 팀의 플레이 기록을 파일에 영구적으로 누적 저장 (게임이 끝날 때마다 계속 쌓임)"""
  path = _playthroughs_path(scenario_id)
  records = _load_playthroughs(scenario_id)
  records.append(record)
  os.makedirs(os.path.dirname(path), exist_ok=True)
  with open(path, "w", encoding="utf-8") as f:
    json.dump(records, f, ensure_ascii=False, indent=2)


async def _check_and_reveal_results(sio, room_id, room_data):
  """전원(GM 제외 플레이어)이 후기와 MVP 투표를 다 제출했으면 결과를 한번에 공개하고,
  이 팀의 플레이 기록을 파일에 영구 저장(여러 팀이 이어서 플레이해도 기록이 계속 쌓임).
  한 번 공개/저장된 뒤에 도착하는 나머지 제출 이벤트들 때문에 중복 저장되지 않도록 방어."""
  # "이미 공개됨" 판정은 플래그가 아니라 실제 결과 데이터(final_results) 존재 여부로 함.
  # (이전에 저장 도중 에러가 나서 플래그만 True로 켜진 채 결과가 실제로 발표되지 못한 상태를 복구하기 위함)
  if room_data.get("game_state", {}).get("final_results"):
    return

  # selections에 GM이 남아있는 경우(예: 원래 GM이 완전히 나가서 캐릭터 보유자가 새 GM으로 승계된 경우)를 대비해
  # 현재 GM은 무조건 제출 대상에서 제외 - 안 그러면 GM 화면엔 후기 폼이 안 뜨니 영원히 완료가 안 되는 상황이 생김
  gm = room_data.get("gm")
  players = [p for p in room_data["selections"].keys() if p != gm]
  if not players:
    return

  feedback = room_data.get("feedback", {})
  mvp_votes = room_data.get("mvp_votes", {})

  all_submitted = all(p in feedback for p in players) and all(p in mvp_votes for p in players)
  if not all_submitted:
    return

  # MVP 집계
  mvp_tally = {}
  for target in mvp_votes.values():
    mvp_tally[target] = mvp_tally.get(target, 0) + 1
  max_votes = max(mvp_tally.values(), default=0)
  mvp_winners = [p for p, c in mvp_tally.items() if c == max_votes and max_votes > 0]

  # 참여자별 후기에 "이 사람이 MVP인지" 여부를 인라인으로 같이 포함 (프론트에서 뱃지로 바로 씀)
  participants_feedback = [
      {
          "nickname": p,
          "character": room_data["selections"].get(p),
          "is_mvp": p in mvp_winners,
          **feedback[p],
      }
      for p in players
  ]

  played_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

  results = {
      "room_id": room_id,
      "played_at": played_at,
      "scenario_id": room_data.get("scenario_id"),
      "selected_ending": room_data.get("game_state", {}).get("selected_ending"),
      "participants": participants_feedback,
      "mvp_tally": mvp_tally,
      "mvp_winners": mvp_winners,
  }

  room_data["game_state"]["results_revealed"] = True

  scenario_id = room_data.get("scenario_id", "scenario_01")
  try:
    _append_playthrough(scenario_id, results)
  except Exception as e:
    # 파일 저장에 실패해도 실시간 발표 자체는 절대 막히면 안 됨 (여기서 죽으면 아래 emit까지 못 감)
    logger.warning(f"⚠️ [results] playthroughs.json 저장 실패 (room_id={room_id}): {e}")

  logger.info(f"🎉 [results] room_id={room_id} 전원 제출 완료 - 결과 공개")

  # 이번 판 결과뿐 아니라, 지금까지 누적된 모든 팀의 기록을 같이 보내서 게시판처럼 볼 수 있게 함
  try:
    all_playthroughs = _load_playthroughs(scenario_id)
  except Exception as e:
    logger.warning(f"⚠️ [results] playthroughs.json 로드 실패 (room_id={room_id}): {e}")
    all_playthroughs = [results]  # 최소한 이번 판 결과라도 보여줌

  payload = {"latest": results, "all_playthroughs": all_playthroughs}
  room_data["game_state"]["final_results"] = payload  # 재접속해도 전체 목록이 그대로 보이도록 game_state에도 저장
  await sio.emit("results_revealed", payload, room=room_id)


async def _push_submission_status_to_gm(sio, room_id, room_data):
  """GM에게 지금까지 누가 후기/MVP를 제출했고 누가 안 했는지 실시간으로 알려줌 (진단용)"""
  gm = room_data.get("gm")
  if not gm:
    return
  players = [p for p in room_data["selections"].keys() if p != gm]
  feedback = room_data.get("feedback", {})
  mvp_votes = room_data.get("mvp_votes", {})

  status = [
      {
          "nickname": p,
          "character": room_data["selections"].get(p),
          "feedback_done": p in feedback,
          "mvp_done": p in mvp_votes,
      }
      for p in players
  ]

  gm_sids = [s for s, info in sid_to_room.items() if info.get("room_id") == room_id and info.get("nickname") == gm]
  for gm_sid in gm_sids:
    await sio.emit("submission_status_update", {"status": status}, to=gm_sid)


def register_ending_handlers(sio, emit_room_state_func):

  @sio.event
  async def request_submission_status(sid, data):
    """GM 전용 - 현재까지 후기/MVP 제출 현황을 수동으로 다시 조회 (결과 화면을 다시 열었을 때 등)"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    if room_id not in rooms:
      return
    room_data = rooms[room_id]
    if nickname != room_data.get("gm"):
      return
    await _push_submission_status_to_gm(sio, room_id, room_data)

  @sio.event
  async def request_ending_form_config(sid, data):
    """GM 전용 - 판정 입력 폼을 어떻게 그릴지(form_fields)와 판정 규칙(rules)을 요청.
    이 시나리오만의 엔딩 분기 로직 전체가 여기 담겨있음 (다른 시나리오는 완전히 다른 폼/규칙을 가질 수 있음).
    스포일러는 아니지만 참여자에게 노출할 이유가 없어서 GM에게만 개별 전송."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname != room_data.get("gm"):
      await sio.emit("error", {"msg": "방장만 엔딩 판정 폼을 열람할 수 있습니다."}, to=sid)
      return

    config = room_data.get("scenario_ending_rules_config") or {"form_fields": [], "rules": []}
    await sio.emit("ending_form_config", {"form_fields": config.get("form_fields", [])}, to=sid)

  @sio.event
  async def compute_ending(sid, data):
    """GM이 (동적으로 그려진 폼에서) 입력한 판정값들을 받아서, 이 시나리오의 규칙(rules)에 따라
    엔딩을 계산해 발표 전 확인용으로 GM에게만 알려줌. 판정값은 필드 종류/개수가 시나리오마다 달라질 수 있어서
    정해진 파라미터 목록이 아니라 자유 형식의 values 딕셔너리로 받음."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    values = data.get("values") or {}

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname != room_data.get("gm"):
      await sio.emit("error", {"msg": "방장만 엔딩을 계산할 수 있습니다."}, to=sid)
      return

    config = room_data.get("scenario_ending_rules_config") or {"form_fields": [], "rules": []}
    ending_id = evaluate_ending_rules(config.get("rules", []), values)

    if ending_id is None:
      await sio.emit("error", {"msg": "입력한 값으로는 판정되는 엔딩이 없습니다. 값을 다시 확인해주세요."}, to=sid)
      return

    endings = room_data.get("scenario_endings", [])
    ending = next((e for e in endings if e.get("id") == ending_id), None)

    if ending is None:
      await sio.emit("error", {"msg": f"계산된 엔딩('{ending_id}')이 endings.json에 없습니다. 데이터를 확인해주세요."}, to=sid)
      return

    logger.info(f"🧮 [compute_ending] {nickname}의 입력값({values})으로 계산된 엔딩: {ending_id}")
    await sio.emit("ending_computed", {"id": ending.get("id"), "title": ending.get("title")}, to=sid)

  @sio.event
  async def request_ending_list(sid, data):
    """GM 전용 - 스포일러 없이 제목/id만 담긴 엔딩 목록 요청 (수동으로 직접 고르고 싶을 때 대비한 예비 경로)"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname != room_data.get("gm"):
      await sio.emit("error", {"msg": "방장만 엔딩을 선택할 수 있습니다."}, to=sid)
      return

    endings = room_data.get("scenario_endings", [])
    summary = [{"id": e.get("id"), "title": e.get("title") or e.get("id")} for e in endings]
    await sio.emit("ending_list", {"endings": summary}, to=sid)

  @sio.event
  async def reveal_ending(sid, data):
    """GM이 엔딩을 선택해서 전원에게 공개. 모든 참여자 인벤토리에 '엔딩 다시보기' 아이템 지급."""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    ending_id = data.get("ending_id")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname != room_data.get("gm"):
      await sio.emit("error", {"msg": "방장만 엔딩을 발표할 수 있습니다."}, to=sid)
      return

    game_state = room_data["game_state"]
    if game_state.get("selected_ending"):
      await sio.emit("error", {"msg": "이미 엔딩이 발표되었습니다."}, to=sid)
      return

    endings = room_data.get("scenario_endings", [])
    ending = next((e for e in endings if e.get("id") == ending_id), None)
    if ending is None:
      await sio.emit("error", {"msg": "존재하지 않는 엔딩입니다."}, to=sid)
      return

    game_state["selected_ending"] = ending_id
    game_state["selected_ending_theme_track"] = ending.get("theme_track")  # GM은 default_ending 아이템을 안 받으므로, 배경음악 전환용으로 game_state에 직접 둠

    scenario_id = room_data.get("scenario_id", "scenario_01")
    # 아직 일러스트가 없으면 이름만 규칙대로 잡아둔 기본 경로 사용 (나중에 파일만 채워 넣으면 자동으로 적용됨)
    default_image = f"/data/{scenario_id}/images/endings/{ending_id}.png"
    ending_image = ending.get("image") or default_image
    if ending_image and not ending_image.startswith("/"):
      ending_image = f"/data/{scenario_id}/images/{ending_image}"

    # 모든 참여자(플레이어, GM 제외)에게 '엔딩 다시보기' 아이템 지급
    objects = game_state.get("objects", {})
    next_id = max(objects.keys(), default=0) + 1
    for player in room_data["selections"].keys():
      objects[next_id] = {
          "id": next_id,
          "group": "default_ending",
          "character_location": None,
          "location": None,
          "character_interview": None,
          "type": "엔딩",
          "speaker": None,
          "target": None,
          "doc_title": ending.get("title") or "엔딩",
          "content": ending.get("content", ""),
          "front_image": ending_image,
          "back_image": ending_image,
          "revealed": True,
          "owner": player,
          "theme_track": ending.get("theme_track"),
      }
      next_id += 1

    logger.info(f"🏮 [reveal_ending] {nickname}가 엔딩 '{ending_id}' 발표")

    # 전원에게 상소문 모달을 즉시 띄우는 전용 이벤트 (일반 상태 브로드캐스트와 별개)
    ending_payload = {
        "id": ending.get("id"),
        "title": ending.get("title"),
        "image": ending_image,
        "content": ending.get("content", ""),
        "theme_track": ending.get("theme_track"),
    }
    await sio.emit("ending_revealed", ending_payload, room=room_id)

    gm = room_data.get("gm")
    await emit_room_state_func(sio, room_id, gm)

  @sio.event
  async def submit_feedback(sid, data):
    """후기/난이도/별점 제출 - 전원 제출 완료 시에만 결과 공개"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    review = (data.get("review") or "")[:2000]
    difficulty = data.get("difficulty")  # "상" / "중" / "하"
    rating = data.get("rating")  # 1~5

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname not in room_data["selections"]:
      return  # GM은 참여자가 아니므로 제출 대상 아님

    if difficulty not in ("상", "중", "하"):
      await sio.emit("error", {"msg": "체감 난이도를 선택해주세요."}, to=sid)
      return
    try:
      rating = int(rating)
    except (TypeError, ValueError):
      rating = None
    if rating not in (1, 2, 3, 4, 5):
      await sio.emit("error", {"msg": "별점은 1~5 사이여야 합니다."}, to=sid)
      return

    room_data.setdefault("feedback", {})[nickname] = {
        "review": review, "difficulty": difficulty, "rating": rating
    }
    logger.info(f"📝 [submit_feedback] {nickname} 후기 제출")

    await sio.emit("feedback_ack", {"msg": "후기가 제출되었습니다. 다른 참여자를 기다리는 중..."}, to=sid)
    await _push_submission_status_to_gm(sio, room_id, room_data)
    await _check_and_reveal_results(sio, room_id, room_data)

  @sio.event
  async def vote_mvp(sid, data):
    """MVP 투표 - 본인 제외, 전원 제출 완료 시에만 결과 공개"""
    room_id = data.get("room_id")
    nickname = data.get("nickname")
    target_nickname = data.get("target_nickname")

    if room_id not in rooms:
      return
    room_data = rooms[room_id]

    if nickname not in room_data["selections"]:
      return

    if target_nickname == nickname:
      await sio.emit("error", {"msg": "자기 자신에게는 투표할 수 없습니다."}, to=sid)
      return
    if target_nickname not in room_data["selections"]:
      await sio.emit("error", {"msg": "존재하지 않는 참여자입니다."}, to=sid)
      return

    room_data.setdefault("mvp_votes", {})[nickname] = target_nickname
    logger.info(f"🏆 [vote_mvp] {nickname} → {target_nickname}")

    await sio.emit("mvp_vote_ack", {"msg": "MVP 투표가 제출되었습니다. 다른 참여자를 기다리는 중..."}, to=sid)
    await _push_submission_status_to_gm(sio, room_id, room_data)
    await _check_and_reveal_results(sio, room_id, room_data)