import { getCharacterImageUrl } from './utils.js';
import { setupBgm } from './bgm.js';
import { createVoiceMesh } from './voice.js';

const socket = io(); // 현재 접속한 주소(로컬/ngrok 등)로 자동 연결
const regex = /^[가-힣0-9]+$/; // 한글과 숫자만 허용

// 세션 스토리지 또는 이전 페이지에서 받아온 값 사용
const nickname = sessionStorage.getItem('nickname');
const roomId = sessionStorage.getItem('roomId');

let roomCharacters = [];
let currentGm = null;
let roomUsers = []; // 방에 있는 전체 유저(GM 포함) 닉네임 목록 - 음성 채널 계산용

const DEFAULT_BG_URL = "url('/data/scenario_01/images/bg.png')";

// 시나리오 id에 맞는 배경 이미지로 전환. 파일이 없으면 기본 배경으로 fallback.
function setBackgroundForScenario(scenarioId) {
    if (!scenarioId) return;
    const path = `/data/${scenarioId}/images/bg.png`;
    const preload = new Image();
    preload.onload = () => {
        document.documentElement.style.setProperty('--bg-url', `url('${path}')`);
    };
    preload.onerror = () => {
        console.warn(`배경 이미지 없음: ${path} → 기본 배경 사용`);
        document.documentElement.style.setProperty('--bg-url', DEFAULT_BG_URL);
    };
    preload.src = path;
}

// 세션스토리지에 저장된 값이 있으면 우선 반영 (재접속 시 깜빡임 최소화)
setBackgroundForScenario(sessionStorage.getItem('scenarioId'));

// 캐릭터 선택 화면부터 배경음악 재생 시작
setupBgm(sessionStorage.getItem('scenarioId'));

// 유효성 검사 및 초기 진입 체크
if (!roomId || !nickname) {
    alert('잘못된 접근입니다. 로비로 돌아갑니다.');
    window.location.href = '/';
} else {
    // 한글/숫자 검증 (방 이름과 닉네임)
    if (!regex.test(roomId) || !regex.test(nickname)) {
        alert("방 이름과 닉네임은 공백이나 특수문자 없이 한글과 숫자만 입력해야 합니다!");
        window.location.href = '/';
    } else {
        document.getElementById('roomTitle').innerText = `대기실 (${roomId})`;
        document.getElementById('myNicknameDisplay').innerText = nickname;
    }
}

socket.on('connect', () => {
    console.log(`🔗 [connect] socket.id=${socket.id}, nickname=${nickname}, roomId=${roomId}`);
    socket.emit('reconnect_room', { nickname, room_id: roomId });
});

// 1. 본인 입장 성공 시
socket.on('room_joined', (data) => {
    console.log('📩 [수신: room_joined]', data);
    roomCharacters = data.characters || [];
    currentGm = data.gm;
    roomUsers = data.users || roomUsers;
    if (data.scenario_id) {
        sessionStorage.setItem('scenarioId', data.scenario_id);
        setBackgroundForScenario(data.scenario_id);
    }
    renderLobby(data.users, data.gm, data.selections);
    renderCharacterCards(data.selections);
    voiceMesh.reconcile();
});

// 2. 다른 사람 입장/선택 등으로 방 상태가 갱신될 때 (방장 및 모든 유저 공용)
socket.on('update_room_state', (data) => {
    console.log('📩 [수신: update_room_state] users:', data.users, 'gm:', data.gm, 'selections:', data.selections);
    currentGm = data.gm;
    roomUsers = data.users || roomUsers;
    if (data.scenario_id) {
        sessionStorage.setItem('scenarioId', data.scenario_id);
        setBackgroundForScenario(data.scenario_id);
    }
    renderLobby(data.users, data.gm, data.selections);
    renderCharacterCards(data.selections); // 캐릭터 선택 현황도 함께 갱신
    voiceMesh.reconcile();
});

// 3. 방 스냅샷 복원
socket.on('room_snapshot_sync', (snapshot) => {
    console.log("📸 [수신: room_snapshot_sync]", snapshot);

    // 이미 게임이 시작된 방이면(뒤로가기 등으로 재진입한 경우) 자동으로 게임 화면으로 이동
    if (snapshot.game_state && snapshot.game_state.started) {
        console.log('↪️ 이미 시작된 게임 - /game으로 자동 이동');
        sessionStorage.setItem('myCharacter', snapshot.selections ? snapshot.selections[nickname] : '');
        window.location.replace('/game');
        return;
    }

    roomCharacters = snapshot.characters || roomCharacters;
    currentGm = snapshot.gm;
    roomUsers = snapshot.users || roomUsers;
    if (snapshot.scenario_id) {
        sessionStorage.setItem('scenarioId', snapshot.scenario_id);
        setBackgroundForScenario(snapshot.scenario_id);
    }
    renderLobby(snapshot.users, snapshot.gm, snapshot.selections);
    renderCharacterCards(snapshot.selections);
    voiceMesh.reconcile();
});

function renderCharacterCards(selections) {
    const grid = document.getElementById('charGrid');
    if (!grid) return;
    grid.innerHTML = '';

    const isMeGm = (nickname === currentGm);

    if (isMeGm) {
        grid.innerHTML = '<p style="grid-column: 1 / -1; font-size: 13px; color: #a99d87;">진행자는 캐릭터를 선택하지 않습니다. 참여자들이 캐릭터를 다 고르면 "다음 단계로 넘어가기"를 눌러주세요.</p>';
        return;
    }

    roomCharacters.forEach(char => {
        const card = document.createElement('div');
        card.className = 'char-card';

        let isSelectedByMe = selections && selections[nickname] === char.name;
        if (isSelectedByMe) {
            card.classList.add('selected-by-me');
        }

        let usersForThisChar = [];
        if (selections) {
            for (const [user, chosenChar] of Object.entries(selections)) {
                if (chosenChar === char.name) {
                    usersForThisChar.push(user);
                }
            }
        }
        // 🛠️ 분리한 헬퍼 함수를 사용하여 확장자/파일명 고민 없이 안전하게 경로 획득
        const currentScenario = sessionStorage.getItem('scenarioId') || 'scenario_01';
        const imagePath = getCharacterImageUrl(currentScenario, char.image);

        card.innerHTML = `
            <img src="${imagePath}" alt="${char.name}" onerror="this.src='/data/default_avatar.png'">
            <h4>${char.name}</h4>
            <p style="font-size: 11px; color: #775; margin: 2px 0 8px 0;">${char.summary}</p>
            <div class="assigned-users">${usersForThisChar.join(', ') || '선택 없음'}</div>
        `;

        card.onclick = () => {
            console.log(`🖱️ [클릭] 캐릭터 선택 요청 전송 → room_id: ${roomId}, nickname: ${nickname}, char_name: ${char.name}`);
            socket.emit('select_character', { room_id: roomId, nickname: nickname, char_name: char.name });
        };

        grid.appendChild(card);
    });
}

function renderLobby(users, gm, selections) {
    const list = document.getElementById('userList');
    if (!list) {
        console.error("오류: 'userList' ID를 가진 태그를 찾을 수 없습니다!");
        return;
    }
    list.innerHTML = '';

    const isMeGm = (nickname === gm);

    users.forEach(user => {
        const li = document.createElement('li');
        const isThisUserGm = (user === gm);
        let chosen = isThisUserGm
            ? ' [진행자]'
            : (selections && selections[user] ? ` [${selections[user]}]` : ' [미선택]');

        const label = document.createElement('span');
        let text = user + chosen;
        if (user === nickname) {
            text += ' (나)';
            li.className = 'my-name';
        }
        label.innerText = text;
        li.appendChild(label);

        if (user === gm) {
            const badge = document.createElement('span');
            badge.className = 'gm-badge';
            badge.innerText = 'GM';
            li.appendChild(badge);
        }

        // 내가 방장이고, 대상이 나 자신이 아닐 때만 위임/강퇴 버튼 표시
        if (isMeGm && user !== nickname) {
            const transferBtn = document.createElement('button');
            transferBtn.className = 'transfer-btn';
            transferBtn.innerText = '방장 위임';
            transferBtn.onclick = () => {
                if (confirm(`${user}님에게 방장을 위임하시겠습니까?`)) {
                    socket.emit('transfer_gm', { room_id: roomId, nickname: nickname, target_nickname: user });
                }
            };
            li.appendChild(transferBtn);

            const kickBtn = document.createElement('button');
            kickBtn.className = 'kick-btn';
            kickBtn.innerText = '강퇴';
            kickBtn.onclick = () => {
                if (confirm(`${user}님을 강퇴하시겠습니까?`)) {
                    socket.emit('kick_user', { room_id: roomId, nickname: nickname, target_nickname: user });
                }
            };
            li.appendChild(kickBtn);
        }

        // 나 자신이 아니면 음성 음량 슬라이더 추가 (로비에서도 방 전체 음성 채널이 켜져있으므로)
        if (user !== nickname) {
            const volumeWrap = document.createElement('div');
            volumeWrap.className = 'voice-volume-row';
            const icon = document.createElement('span');
            icon.className = 'voice-volume-icon';
            icon.innerText = '🔉';
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'voice-volume-slider';
            slider.min = '0';
            slider.max = '100';
            slider.value = String(Math.round(voiceMesh.getPeerVolume(user) * 100));
            slider.addEventListener('input', (e) => {
                voiceMesh.setPeerVolume(user, Number(e.target.value) / 100);
            });
            volumeWrap.appendChild(icon);
            volumeWrap.appendChild(slider);
            li.appendChild(volumeWrap);
        }

        list.appendChild(li);
    });

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) {
        nextBtn.style.display = isMeGm ? 'block' : 'none';
    }

    // 랜덤 선택 버튼도 방장 전용
    const randomBtn = document.getElementById('randomBtn');
    if (randomBtn) {
        randomBtn.style.display = isMeGm ? 'block' : 'none';
    }
}

socket.on('start_game_phase', (data) => {
    console.log('🎬 [start_game_phase] 게임 화면으로 이동:', data);
    sessionStorage.setItem('myCharacter', data.selections ? data.selections[nickname] : '');
    window.location.replace('/game'); // href 대신 replace: 뒤로가기로 대기실에 다시 못 돌아오게
});

socket.on('error', (data) => {
    alert(data.msg);
});

function leaveRoom() {
    if (confirm('정말 방을 나가시겠습니까?')) {
        socket.emit('leave_room_explicit', { nickname, room_id: roomId });
    }
}

socket.on('left_success', () => {
    sessionStorage.clear();
    window.location.href = '/';
});

socket.on('room_destroyed', (data) => {
    alert((data && data.msg) || '방이 사라졌거나 존재하지 않습니다.');
    sessionStorage.clear();
    socket.disconnect();
    window.location.replace('/');
});

socket.on('kicked', (data) => {
    console.log('🚪 [kicked] 강퇴 이벤트 수신:', data);
    alert(data.msg || '방장에 의해 강퇴되었습니다.');
    sessionStorage.clear();
    socket.disconnect(); // 강퇴 후 재접속 이벤트 등이 다시 발동하지 않도록 소켓 정리
    window.location.replace('/'); // 뒤로가기로 대기실에 다시 못 돌아오도록 replace 사용
});

socket.on('duplicate_session', (data) => {
    console.log('🔁 [duplicate_session] 중복 접속으로 인한 세션 종료:', data);
    alert(data.msg || '다른 곳에서 새로 접속되어 이전 연결이 종료되었습니다.');
    sessionStorage.clear();
    socket.disconnect();
    window.location.replace('/');
});

// 버튼 이벤트 바인딩 (randomBtn, nextBtn, leaveBtn 모두 여기서 일괄 등록)
document.getElementById('randomBtn')?.addEventListener('click', () => {
    socket.emit('random_assign', { room_id: roomId, nickname: nickname });
});

document.getElementById('nextBtn')?.addEventListener('click', () => {
    socket.emit('next_phase', { room_id: roomId, nickname: nickname });
});

document.getElementById('leaveBtn')?.addEventListener('click', leaveRoom);

// ── 음성통화 (voice.js 공용 모듈 사용) ─────────────────────────────
// 로비엔 "밀담" 개념이 없어서 규칙이 단순함 - 방에 있는 모두(GM 포함)와 항상 연결.
function getDesiredVoicePeers() {
    return roomUsers.filter(n => n !== nickname);
}

const voiceMesh = createVoiceMesh({
    socket,
    getRoomId: () => roomId,
    getNickname: () => nickname,
    getDesiredPeers: getDesiredVoicePeers,
    onStatusChange: updateVoiceStatusUI,
});

function updateVoiceStatusUI() {
    const bar = document.getElementById('voiceStatusBar');
    if (!bar) return;

    if (voiceMesh.isMicDenied()) {
        bar.style.display = 'flex';
        document.getElementById('voiceStatusText').innerText = '🎙️ 마이크 권한이 없어 음성통화를 쓸 수 없습니다';
        document.getElementById('voiceMuteBtn').style.display = 'none';
        return;
    }

    const peerCount = voiceMesh.getPeerCount();
    if (peerCount === 0) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';
    document.getElementById('voiceMuteBtn').style.display = '';
    document.getElementById('voiceStatusText').innerText = `🎙️ 로비 음성 연결됨 (${peerCount}명)`;

    const muted = voiceMesh.isMuted();
    const muteBtn = document.getElementById('voiceMuteBtn');
    muteBtn.innerText = muted ? '🎤 마이크 꺼짐' : '🎤 마이크 켜짐';
    muteBtn.classList.toggle('mic-off', muted);
    muteBtn.classList.toggle('mic-on', !muted);
    bar.classList.toggle('mic-off', muted);
}

document.getElementById('voiceMuteBtn')?.addEventListener('click', () => voiceMesh.toggleMute());