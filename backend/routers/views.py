# backend/routers/views.py
import os
from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse
from backend.services.scenario_loader import get_available_scenarios

router = APIRouter()

# frontend 폴더 경로 설정 (backend 기준 상위로 올라갔다 frontend로 진입)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "../../frontend")


@router.get("/", response_class=HTMLResponse)
def read_root():
  path = os.path.join(FRONTEND_DIR, "index.html")
  with open(path, "r", encoding="utf-8") as f:
    return f.read()


@router.get("/room", response_class=HTMLResponse)
def read_room():
  path = os.path.join(FRONTEND_DIR, "room.html")
  with open(path, "r", encoding="utf-8") as f:
    return f.read()


@router.get("/game", response_class=HTMLResponse)
def read_game():
  path = os.path.join(FRONTEND_DIR, "game.html")
  with open(path, "r", encoding="utf-8") as f:
    return f.read()


@router.get("/api/scenarios")
def list_scenarios():
  return JSONResponse(get_available_scenarios())