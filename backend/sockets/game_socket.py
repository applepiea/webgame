from .handlers.game_handler import register_game_handlers
from .handlers.room_handler import register_room_handlers, rooms, sid_to_room
from .handlers.object_handler import register_object_handlers
from .handlers.conversation_handler import register_conversation_handlers
from .handlers.ending_handler import register_ending_handlers
from backend.logging_setup import get_logger

logger = get_logger(__name__)


async def emit_room_state(sio, room_id, gm):
  room_data = rooms.get(room_id)
  if room_data is None:
    logger.info(f"[emit_room_state] 존재하지 않는 방에 접근 시도: {room_id}")
    return

  logger.info(f"📡 [emit_room_state] room_id={room_id} 로 브로드캐스트 → users={room_data['users']}, gm={gm}, selections={room_data['selections']}")

  await sio.emit(
      "update_room_state",
      {
          "users": room_data["users"],
          "gm": gm,
          "temp_gm": room_data.get("temp_gm"),
          "selections": room_data["selections"],
          "characters": room_data["characters"],
          "game_state": room_data.get("game_state"),
          "scenario_id": room_data.get("scenario_id")
      },
      room=room_id
  )


def register_socket_events(sio):

  @sio.event
  async def connect(sid, environ):
    logger.info(f"클라이언트 연결됨: {sid}")

  @sio.event
  async def disconnect(sid):
    logger.info(f"클라이언트 연결 끊김: {sid}")
    if sid in sid_to_room:
      info = sid_to_room.pop(sid)
      logger.info(f"🧹 [disconnect] sid_to_room에서 정리됨: {info}")

      room_id = info.get("room_id")
      nickname = info.get("nickname")
      room_data = rooms.get(room_id)

      # 끊긴 사람이 '진짜 방장'이었다면, 다음으로 들어온(현재 접속 중인) 참여자를 임시 방장으로 지정
      # (영구 위임이 아니라 임시 - 진짜 방장이 재접속하면 자동으로 회수됨)
      if room_data and room_data.get("gm") == nickname:
        connected_nicknames = {
            v.get("nickname") for k, v in sid_to_room.items() if v.get("room_id") == room_id
        }
        # gm 본인을 제외한, 입장 순서상 먼저 들어온 사람부터 확인
        candidates = [u for u in room_data["users"] if u != nickname]
        temp_gm_candidate = next((u for u in candidates if u in connected_nicknames), None)

        room_data["temp_gm"] = temp_gm_candidate
        if temp_gm_candidate:
          logger.info(f"👑 [disconnect] 방장({nickname}) 연결 끊김 → {temp_gm_candidate}를 임시 방장으로 지정 (페이즈 넘기기 권한만)")
        else:
          logger.warning(f"⚠️ [disconnect] 방장({nickname}) 연결 끊김 → 임시 방장으로 지정할 접속 중인 참여자가 없음")
        await emit_room_state(sio, room_id, room_data.get("gm"))

  register_room_handlers(sio, emit_room_state)
  register_game_handlers(sio, emit_room_state)
  register_object_handlers(sio, emit_room_state)
  register_conversation_handlers(sio, emit_room_state)
  register_ending_handlers(sio, emit_room_state)