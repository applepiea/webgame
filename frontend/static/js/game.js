import { getCharacterImageUrl } from './utils.js';
import { setupBgm, switchBgmTrack, stopBgm } from './bgm.js';
import { createVoiceMesh } from './voice.js';

const socket = io(); // 현재 접속한 주소(로컬/ngrok 등)로 자동 연결

const nickname = sessionStorage.getItem('nickname');
const roomId = sessionStorage.getItem('roomId');
const myCharacter = sessionStorage.getItem('myCharacter') || '';

let gameState = { phase: 1, objects: {} };
let selections = {};
let roomUsers = []; // 방에 있는 전체 유저(GM 포함) 닉네임 목록 - 음성 채널 계산용
let characters = [];
let phasesList = [];
let currentGm = null;
let currentTempGm = null;
let timerIntervalId = null;
let noteEverLoaded = false; // 서버에서 받은 초기 메모값을 한 번만 반영하기 위한 플래그 (이후엔 로컬 입력이 우선)

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
loadMapConfig(sessionStorage.getItem('scenarioId'));
loadAbilityConfig(sessionStorage.getItem('scenarioId'));

// 배경음악 재생 시작 (음량/음소거 설정은 room.html에서 저장한 값을 이어받음)
setupBgm(sessionStorage.getItem('scenarioId'));

if (!roomId || !nickname) {
    alert('잘못된 접근입니다. 로비로 돌아갑니다.');
    window.location.href = '/';
} else {
    document.getElementById('roomTitleGame').innerText = `게임 진행 중 (${roomId})`;
    document.getElementById('myCharDisplay').innerText = myCharacter || '-';
}

socket.on('connect', () => {
    console.log(`🔗 [connect] socket.id=${socket.id}, nickname=${nickname}`);
    socket.emit('reconnect_room', { nickname, room_id: roomId });
});

socket.on('room_snapshot_sync', (snapshot) => {
    console.log('📸 [room_snapshot_sync]', snapshot);
    selections = snapshot.selections || {};
    roomUsers = snapshot.users || roomUsers;
    characters = snapshot.characters || characters;
    gameState = snapshot.game_state || gameState;
    phasesList = gameState.phases || phasesList;
    currentGm = snapshot.gm || currentGm;
    currentTempGm = snapshot.temp_gm;
    if (typeof snapshot.my_note === 'string' && !noteEverLoaded) {
        document.getElementById('noteTextarea').value = snapshot.my_note;
        noteEverLoaded = true;
    }
    if (snapshot.scenario_id) {
        sessionStorage.setItem('scenarioId', snapshot.scenario_id);
        setBackgroundForScenario(snapshot.scenario_id);
        loadMapConfig(snapshot.scenario_id);
        loadAbilityConfig(snapshot.scenario_id);
    }
    applyMySubmittedFeedback(snapshot.my_feedback, snapshot.my_mvp_vote);
    applyState();
});

socket.on('update_room_state', (data) => {
    console.log('📩 [update_room_state]', data);
    selections = data.selections || selections;
    roomUsers = data.users || roomUsers;
    characters = data.characters || characters;
    gameState = data.game_state || gameState;
    phasesList = gameState.phases || phasesList;
    currentGm = data.gm || currentGm;
    currentTempGm = data.temp_gm;
    if (data.scenario_id) {
        sessionStorage.setItem('scenarioId', data.scenario_id);
        setBackgroundForScenario(data.scenario_id);
        loadMapConfig(data.scenario_id);
        loadAbilityConfig(data.scenario_id);
    }
    applyState();
});

// 서버가 특정 요청자에게만 보내는 경고/에러 메시지 (조사시간 아님, 개수 한도 초과, 내월당 제한 등)
// 서버가 이미 to=sid로 요청한 사람에게만 보내주고 있어서, 여기서 그대로 alert만 띄우면 다른 사람에겐 안 보임
socket.on('error', (data) => {
    console.warn('⚠️ [error]', data);
    alert(data.msg || '요청을 처리할 수 없습니다.');
});

// 특정 캐릭터가 특정 아이템을 가질 때마다(획득/건네받음 모두) 뜨는 개인용 알림
socket.on('item_aversion', (data) => {
    console.log('😨 [item_aversion]', data);
    alert(data.msg);
});

// 특정 캐릭터가 밀담으로 아이템을 보거나 건네받을 때 뜨는 맞춤 알림 (special_reactions)
socket.on('item_notice', (data) => {
    console.log('💭 [item_notice]', data);
    alert(data.msg);
});

socket.on('kicked', (data) => {
    alert(data.msg || '방장에 의해 강퇴되었습니다.');
    sessionStorage.clear();
    socket.disconnect();
    window.location.replace('/');
});

socket.on('duplicate_session', (data) => {
    alert(data.msg || '다른 곳에서 새로 접속되어 이전 연결이 종료되었습니다.');
    sessionStorage.clear();
    socket.disconnect();
    window.location.replace('/');
});

socket.on('room_destroyed', (data) => {
    alert((data && data.msg) || '방이 사라졌거나 존재하지 않습니다.');
    sessionStorage.clear();
    socket.disconnect();
    window.location.replace('/');
});

function applyState() {
    renderPhaseBlock();

    // 내 캐릭터 표시 갱신 (혹시 room.js에서 세션에 못 담고 왔을 경우 대비)
    if (!myCharacter && selections[nickname]) {
        document.getElementById('myCharDisplay').innerText = selections[nickname];
    }

    renderBoard();
    renderCharacterBoard();
    renderInventory();
    voiceMesh.reconcile();

    // GM에게만 엔딩 발표 버튼 노출 (이미 발표됐으면 숨김)
    const revealBtn = document.getElementById('revealEndingBtn');
    const isGmForBtns = currentGm === nickname;
    if (revealBtn) {
        revealBtn.style.display = (isGmForBtns && !gameState.selected_ending) ? 'inline-block' : 'none';
    }

    // GM에게만 오브젝트 현황판 버튼 노출, 열려있으면 실시간 갱신
    const statusBoardBtn = document.getElementById('statusBoardToggleBtn');
    if (statusBoardBtn) {
        statusBoardBtn.style.display = isGmForBtns ? 'inline-block' : 'none';
        if (document.getElementById('statusBoardPanel').classList.contains('open')) {
            renderStatusBoard();
        }
    }

    // 엔딩이 발표된 이후엔 누구나 언제든 결과 화면을 다시 열어볼 수 있음
    const viewResultsBtn = document.getElementById('viewResultsBtn');
    if (viewResultsBtn) {
        viewResultsBtn.style.display = gameState.selected_ending ? 'inline-block' : 'none';
    }

    maybeShowResultsOverlay();
}

let resultsOverlayOpened = false;

// 엔딩이 발표된 상태면 결과 페이지를 열어두고, 이미 전원 제출 완료된 결과가 있으면 같이 채워넣음
// (재접속해도 game_state.selected_ending / final_results로 그대로 복원됨)
function maybeShowResultsOverlay() {
    const isGm = currentGm === nickname;
    const resultsAlreadyRevealed = !!gameState.results_revealed;

    // GM은 참여자가 아니라서 후기/MVP를 제출할 대상이 아님 - 작성 폼 대신 "대기 중" 안내만 보여줌
    const feedbackForm = document.getElementById('feedbackForm');
    const gmWaitingNotice = document.getElementById('gmWaitingNotice');
    if (feedbackForm) feedbackForm.style.display = (isGm || resultsAlreadyRevealed) ? 'none' : '';
    if (gmWaitingNotice) gmWaitingNotice.style.display = (isGm && !resultsAlreadyRevealed) ? 'block' : 'none';
    if (isGm && !resultsAlreadyRevealed && gameState.selected_ending) {
        socket.emit('request_submission_status', { room_id: roomId, nickname });
    }

    if (gameState.selected_ending && !resultsOverlayOpened) {
        resultsOverlayOpened = true;
        document.getElementById('resultsOverlay').classList.add('open');
        renderResultsParticipants();
        if (!isGm) renderMvpPicker();
    }
    // 최초 오픈 시점과 무관하게, 엔딩이 발표된 상태면 매번 확실히 노출 (재접속/새로고침 타이밍 이슈 방지)
    if (gameState.selected_ending) {
        document.getElementById('backToBoardBtn').style.display = 'block';
    }
    if (gameState.final_results) {
        renderRevealedResults(gameState.final_results);
    }
}

// 지도 위 클릭 영역(핫스팟)/방 배경/툴팁 - 전부 시나리오 데이터(data/{scenario}/map_config.json)에서 로드.
// 파일이 없는 시나리오는 hotspots가 빈 배열이 되어, 지도 이미지 틀은 그대로 뜨되 클릭 가능한 구역만 없는 상태가 됨.
let mapConfig = { hotspots: [] };
let mapConfigLoadedForScenario = null; // 같은 시나리오로 중복 fetch 방지

// 심문 같은 "특정 캐릭터 전용 특수 능력" 관련 UI 문구의 틀(공용 기본값)은 시나리오 폴더가 아니라
// data/ 바로 밑(모든 시나리오 공용)에 두고, 시나리오 폴더에는 그 시나리오만의 실제 값(캐릭터명/대사)만 둠.
// 예) data/special_ability_config.default.json = 공용 틀
//     data/scenario_01/special_ability_config.json = 시나리오 1만의 값 (틀의 필드를 원하는 만큼 덮어씀)
let abilityDefaultTemplate = {};
let abilityDefaultTemplateLoaded = false;
let abilityConfig = {};
let abilityConfigLoadedForScenario = null;

async function loadAbilityDefaultTemplate() {
    if (abilityDefaultTemplateLoaded) return;
    try {
        const res = await fetch('/data/special_ability_config.default.json');
        if (!res.ok) throw new Error(`status ${res.status}`);
        abilityDefaultTemplate = await res.json();
    } catch (e) {
        console.warn('⚠️ special_ability_config.default.json 로드 실패 - 틀 없이 시나리오 값만 사용:', e.message);
        abilityDefaultTemplate = {};
    }
    abilityDefaultTemplateLoaded = true;
}

async function loadAbilityConfig(scenarioId) {
    if (!scenarioId || abilityConfigLoadedForScenario === scenarioId) return;
    await loadAbilityDefaultTemplate(); // 공용 틀은 한 번만 받아오면 됨 (시나리오 안 바뀜)

    let scenarioOverrides = {};
    try {
        const res = await fetch(`/data/${scenarioId}/special_ability_config.json`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        scenarioOverrides = await res.json();
    } catch (e) {
        scenarioOverrides = {}; // 이 시나리오엔 파일 자체가 없음(기능 없음) - 틀만 남아도 ability_character가 없어서 어차피 안 쓰임
    }

    abilityConfig = { ...abilityDefaultTemplate, ...scenarioOverrides }; // 틀 위에 시나리오 값을 덮어씀
    abilityConfigLoadedForScenario = scenarioId;
    renderCharacterBoard(); // 버튼 문구 반영을 위해 다시 그림
}

// {target}, {requester} 같은 자리표시자를 실제 값으로 치환
function fillTemplate(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
}

async function loadMapConfig(scenarioId) {
    if (!scenarioId || mapConfigLoadedForScenario === scenarioId) return;
    try {
        const res = await fetch(`/data/${scenarioId}/map_config.json`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        mapConfig = await res.json();
    } catch (e) {
        console.warn(`🗺️ map_config.json 없음/로드 실패 (${scenarioId}) - 지도는 뜨되 핫스팟 없이 표시됩니다:`, e.message);
        mapConfig = { hotspots: [] };
    }
    mapConfigLoadedForScenario = scenarioId;
    renderBoard(); // 로딩이 끝난 뒤 한 번 더 그려서 핫스팟을 반영
}

// 오브젝트 하나를 보고 그게 속한 장소의 방 배경 이미지 파일명을 찾음 (없으면 null)
function getRoomBackgroundImageForObject(obj) {
    if (!obj) return null;
    // subLocations(외당/내당처럼 하위 구역별 이미지)가 있는 핫스팟이면 그 구역 이미지를,
    // 없으면 오브젝트 자체가 속한 장소(character_location)에 매칭되는 핫스팟의 roomImage를 사용
    const spotBySubLocation = mapConfig.hotspots.find(s => s.subLocations && s.matchField === 'group' && obj[s.matchField] === s.matchValue);
    if (spotBySubLocation) {
        return spotBySubLocation.subLocations[obj.location]?.image || null;
    }
    const spot = mapConfig.hotspots.find(s => s.matchField === 'character_location' && s.matchValue === obj.character_location);
    return spot ? (spot.roomImage || null) : null;
}

// 마지막 페이즈(엔딩)에 도달했는지 판별 - 도달 시 전원 공개 모드
function isEndingRevealed() {
    return phasesList.length > 0 && (gameState.phase || 1) >= phasesList.length;
}

// 발표된 엔딩의 배경음악 트랙명을 조회 (game_state에 직접 있어서 GM 포함 누구나 바로 조회 가능)
function myEndingThemeTrack() {
    return gameState.selected_ending_theme_track || null;
}

// ── 구역(zone) 카테고리 계산 (인터뷰 칩 목록에서 사용) ─────────────────────────────
function getSubZones(categoryKey) {
    const objects = Object.values(gameState.objects || {});
    let field;
    if (categoryKey === 'location') field = 'character_location';
    else if (categoryKey === 'naewoldang') field = 'location';
    else if (categoryKey === 'interview') field = 'character_interview';
    else return [];

    const values = objects
        .filter(o => o.group === categoryKey)
        .map(o => o[field])
        .filter(Boolean);

    return [...new Set(values)];
}

let selectedMapKey = null; // 현재 선택된 장소/화자 (mapHotspot.key 또는 'interview:화자이름')

// 단서 오브젝트 하나를 카드 엘리먼트로 만드는 공용 함수 (지도 상세패널, 인터뷰 패널 공용)
function buildObjectCard(obj, { isInvestigation, ended, myCharacter }) {
    const isOwnInterview = obj.group === 'interview' && obj.speaker === myCharacter;
    const isOwnLocation = obj.group === 'location' && myCharacter && (obj.character_location || '').includes(myCharacter);

    // 배타적 페이즈(exclusive_phase) 지정된 오브젝트: 그 페이즈엔 조사 시간 여부와 상관없이 지정된 캐릭터만 열람 가능
    const isExclusivePhaseNow = obj.exclusive_character
        && obj.exclusive_phase != null
        && (gameState.phase || 1) === obj.exclusive_phase;
    const isExclusiveMatch = isExclusivePhaseNow && obj.exclusive_character === myCharacter;

    const locked = !ended && !obj.owner && (
        isOwnInterview || isOwnLocation ||
        (isExclusivePhaseNow ? !isExclusiveMatch : !isInvestigation)
    );

    const card = document.createElement('div');
    card.className = 'obj-card' + (obj.owner && !ended ? ' owned-by-other' : '') + (locked ? ' locked-phase' : '');

    let tooltip;
    if (ended) tooltip = obj.owner ? `${obj.type} · ${obj.owner} 획득` : `${obj.type} (미획득)`;
    else if (obj.owner) tooltip = `${obj.type} · ${obj.owner} 획득`;
    else if (!ended && isOwnInterview) tooltip = '자신이 한 말은 선택할 수 없습니다';
    else if (!ended && isOwnLocation) tooltip = '자신의 처소에 있는 물건은 스스로 조사할 수 없습니다';
    else if (locked && isExclusivePhaseNow) tooltip = `지금은 '${obj.exclusive_character}'만 확인할 수 있습니다`;
    else if (locked) tooltip = '조사 시간에만 확인할 수 있습니다';
    else tooltip = obj.type;

    card.innerHTML = `
        <img src="${ended ? (obj.back_image || obj.front_image) : obj.front_image}" alt="${obj.type}" title="${tooltip}" onerror="this.src='/data/default_avatar.png'">
        ${locked ? '<div class="lock-overlay">🔒</div>' : ''}
    `;

    if (ended) {
        card.onclick = () => openZoomModal(obj);
    } else if (!obj.owner && !locked) {
        card.onclick = () => {
            console.log(`🖱️ [클릭] claim_object 요청 → object_id=${obj.id}`);
            socket.emit('claim_object', { room_id: roomId, nickname: nickname, object_id: obj.id });
        };
    }

    return card;
}

// ── 보드 렌더링: 지도 위 클릭 영역 + 선택한 곳의 단서 상세 패널 ─────────────────────────────
function renderBoard() {
    const mapImage = document.getElementById('mapImage');
    const scenarioId = sessionStorage.getItem('scenarioId') || 'scenario_01';
    const mapPath = `/data/${scenarioId}/images/map.png`;
    if (mapImage.getAttribute('src') !== mapPath) {
        mapImage.src = mapPath;
    }

    const currentPhaseInfo = phasesList[(gameState.phase || 1) - 1];
    const isInvestigation = !!(currentPhaseInfo && currentPhaseInfo.is_investigation);
    const ended = isEndingRevealed();
    const myCharacter = selections[nickname];
    const allObjects = Object.values(gameState.objects || {});

    // 장소별 미획득(또는 엔딩 이후 전체) 단서 개수 배지 계산 후 핫스팟 렌더링
    const hotspotsContainer = document.getElementById('mapHotspots');
    hotspotsContainer.innerHTML = '';

    mapConfig.hotspots.forEach(spot => {
        const objectsHere = allObjects.filter(o => o[spot.matchField] === spot.matchValue);
        const availableCount = objectsHere.filter(o => o.owner !== nickname && (ended || !o.owner)).length;

        const el = document.createElement('div');
        el.className = 'map-hotspot' + (selectedMapKey === spot.key ? ' active' : '');
        el.title = spot.tooltip || spot.label;
        el.style.left = spot.left + '%';
        el.style.top = spot.top + '%';
        el.style.width = spot.width + '%';
        el.style.height = spot.height + '%';
        el.innerHTML = availableCount > 0 ? `<div class="map-hotspot-badge">${availableCount}</div>` : '';
        el.onclick = () => {
            selectedMapKey = spot.key;
            renderBoard();
        };
        hotspotsContainer.appendChild(el);
    });

    // 인터뷰 칩 (물리적 장소가 없는 카드들 - 화자별로)
    const interviewChipRow = document.getElementById('interviewChipRow');
    interviewChipRow.innerHTML = '';
    const speakers = getSubZones('interview');
    speakers.forEach(speaker => {
        const chipKey = `interview:${speaker}`;
        const chip = document.createElement('div');
        chip.className = 'interview-chip' + (selectedMapKey === chipKey ? ' active' : '');
        chip.innerText = `💬 ${speaker}의 인터뷰`;
        chip.onclick = () => {
            selectedMapKey = chipKey;
            renderBoard();
        };
        interviewChipRow.appendChild(chip);
    });

    // 상세 패널: 선택된 장소/화자의 단서 목록
    const detailTitle = document.getElementById('mapDetailTitle');
    const detailGrid = document.getElementById('mapDetailGrid');
    detailGrid.innerHTML = '';

    let objectsToShow = [];
    let titleText = '장소를 클릭해서 단서를 확인하세요';

    if (selectedMapKey && selectedMapKey.startsWith('interview:')) {
        const speaker = selectedMapKey.slice('interview:'.length);
        objectsToShow = allObjects.filter(o => o.group === 'interview' && o.character_interview === speaker);
        titleText = `💬 ${speaker}의 인터뷰`;
    } else if (selectedMapKey) {
        const spot = mapConfig.hotspots.find(s => s.key === selectedMapKey);
        if (spot) {
            objectsToShow = allObjects.filter(o => o[spot.matchField] === spot.matchValue);
            titleText = spot.label;
        }
    }

    detailTitle.innerText = titleText;

    const visibleObjects = objectsToShow
        .filter(o => o.owner !== nickname) // 내가 이미 가져간 건 인벤토리에서 보면 되니 상세패널에선 숨김
        .sort((a, b) => a.id - b.id);

    const scenarioIdForBg = sessionStorage.getItem('scenarioId') || 'scenario_01';
    const detailPanel = document.getElementById('mapDetailPanel');
    const selectedSpot = selectedMapKey ? mapConfig.hotspots.find(s => s.key === selectedMapKey) : null;

    if (selectedSpot && selectedSpot.subLocations) {
        // subLocations(외당/내당처럼 하위 구역별 이미지)가 있는 핫스팟은 패널 전체가 아니라
        // 하위 구역(location 필드) 별로 각자 다른 방 배경을 씀
        detailPanel.classList.remove('has-room-bg');
        detailPanel.style.backgroundImage = '';

        const subLocations = [...new Set(visibleObjects.map(o => o.location).filter(Boolean))];
        subLocations.forEach(sub => {
            const rowWrap = document.createElement('div');
            rowWrap.className = 'zone-section';
            const subImage = selectedSpot.subLocations[sub]?.image;
            if (subImage) {
                rowWrap.classList.add('has-room-bg');
                rowWrap.style.backgroundImage = `url('/data/${scenarioIdForBg}/images/objects/${subImage}')`;
            }
            rowWrap.innerHTML += `<div class="zone-section-title">${sub}</div>`;

            const row = document.createElement('div');
            row.className = 'zone-grid';
            visibleObjects
                .filter(o => o.location === sub)
                .forEach(obj => row.appendChild(buildObjectCard(obj, { isInvestigation, ended, myCharacter })));

            rowWrap.appendChild(row);
            detailGrid.appendChild(rowWrap);
        });
    } else {
        // 캐릭터 처소면 상세 패널 전체에 그 방 이미지를 배경으로 (인터뷰 칩 등 장소가 아니면 배경 없음)
        const roomImage = selectedSpot?.roomImage;
        if (roomImage) {
            detailPanel.classList.add('has-room-bg');
            detailPanel.style.backgroundImage = `url('/data/${scenarioIdForBg}/images/objects/${roomImage}')`;
        } else {
            detailPanel.classList.remove('has-room-bg');
            detailPanel.style.backgroundImage = '';
        }

        const row = document.createElement('div');
        row.className = 'zone-grid';
        visibleObjects.forEach(obj => row.appendChild(buildObjectCard(obj, { isInvestigation, ended, myCharacter })));
        detailGrid.appendChild(row);
    }

    if (selectedMapKey && objectsToShow.length === 0) {
        detailGrid.innerHTML = '<div id="emptyState">이곳에는 단서가 없습니다.</div>';
    }
}

// ── 참여자 목록 (오른쪽 세로 바, 클릭 시 보유 오브젝트 펼쳐짐) ─────────────────────────────
let expandedParticipant = null; // 현재 펼쳐진 참여자 닉네임

// 내가 참여 중인 밀담 찾기
function findMyConversation() {
    const conversations = gameState.conversations || {};
    for (const [id, conv] of Object.entries(conversations)) {
        if (conv.participants.includes(nickname)) return { id, ...conv };
    }
    return null;
}

// 특정 닉네임이 참여 중인 밀담 찾기 (누구와도)
function findConversationForUser(targetNickname) {
    const conversations = gameState.conversations || {};
    for (const conv of Object.values(conversations)) {
        if (conv.participants.includes(targetNickname)) return conv;
    }
    return null;
}

function renderCharacterBoard() {
    const container = document.getElementById('characterBoard');
    container.innerHTML = '';

    const entries = Object.entries(selections).filter(([, charName]) => charName);

    if (entries.length === 0) {
        container.innerHTML = '<div class="char-inv-empty">아직 배정된 캐릭터가 없습니다.</div>';
        return;
    }

    const myConv = findMyConversation();
    const pending = gameState.pending_invites || {};
    const ended = isEndingRevealed();

    entries.forEach(([userNickname, charName]) => {
        const charInfo = characters.find(c => c.name === charName) || {};
        const imagePath = getCharacterImageUrl(sessionStorage.getItem('scenarioId') || 'scenario_01', charInfo.image);
        const isMe = userNickname === nickname;

        const ownedItems = Object.values(gameState.objects || {})
            .filter(o => o.owner === userNickname)
            .sort((a, b) => a.id - b.id);

        const row = document.createElement('div');
        row.className = 'participant-row' + (isMe ? ' is-me' : '');

        const isOpen = expandedParticipant === userNickname;

        const canView = isMe || ended;
        const thumbsHtml = ownedItems.length > 0
            ? ownedItems.map(obj => `<img data-obj-id="${obj.id}" class="${canView ? 'clickable' : 'locked'}" src="${obj.back_image || obj.front_image}" onerror="this.src='/data/default_avatar.png'" title="${canView ? '' : '다른 참여자의 아이템입니다'}">`).join('')
            : '<span style="font-size:10px;color:#666;">획득한 오브젝트 없음</span>';

        // 밀담 상태/버튼 구성 (캐릭터 주인만 각자의 버튼을 클릭할 수 있음)
        const currentPhaseInfoForTalk = phasesList[(gameState.phase || 1) - 1];
        const isInvestigationForTalk = !!(currentPhaseInfoForTalk && currentPhaseInfoForTalk.is_investigation);

        let talkControlHtml = '';
        if (isMe) {
            if (myConv) {
                // 이미 진행 중인 밀담은 조사 시간이 끝나도 종료 버튼은 계속 보이게 (페이즈 전환 시 서버가 자동 종료하긴 하지만 방어적으로)
                talkControlHtml = `<button class="talk-btn talk-end" data-action="end">🤐 밀담 종료</button>`;
                // 음성통화는 이제 버튼 없이 완전 자동 - 밀담 성사/종료에 맞춰 알아서 연결/해제됨 (voiceMesh.reconcile 참고)
            }
        } else if (isInvestigationForTalk) {
            const theirConv = findConversationForUser(userNickname);
            if (theirConv) {
                talkControlHtml = (myConv && myConv.participants.includes(userNickname))
                    ? `<div class="talk-status talk-active">🗣 나와 밀담 중</div>`
                    : `<div class="talk-status">🗣 밀담 중</div>`;
            } else if (myConv) {
                talkControlHtml = `<div class="talk-status disabled">밀담 불가</div>`;
            } else if (pending[nickname] === userNickname) {
                talkControlHtml = `<button class="talk-btn talk-cancel" data-action="cancel">요청 취소</button>`;
            } else if (pending[userNickname] === nickname) {
                talkControlHtml = `<button class="talk-btn talk-accept" data-action="accept" data-target="${userNickname}">밀담 수락</button>`;
            } else {
                talkControlHtml = `<button class="talk-btn talk-invite" data-action="invite" data-target="${userNickname}">밀담 신청</button>`;
            }
        }
        // isInvestigationForTalk가 false면(조사 시간 아님) 남의 카드엔 아무 버튼도 안 뜸

        // 이윤 전용: 심문 신청 버튼 (조사 시간 + 이번 페이즈 미사용 + 재지목 아닌 대상 + 대기 중 요청 없을 때만)
        let interrogateHtml = '';
        if (!isMe && isInvestigationForTalk && gameState.special_ability_character && myCharacter === gameState.special_ability_character) {
            const alreadyUsed = !!gameState.interrogation_used_this_phase;
            const alreadyTargeted = (gameState.interrogated_targets || []).includes(userNickname);
            if (!alreadyUsed && !alreadyTargeted) {
                interrogateHtml = `<button class="talk-btn interrogate-btn" data-action="interrogate" data-target="${userNickname}">${abilityConfig.action_label}</button>`;
            }
        }

        // 다른 참여자 목소리 크기 개별 조절 (내 카드엔 안 뜸 - 내 목소리를 내가 조절할 이유는 없으니까)
        const volumeHtml = isMe ? '' : `
            <div class="voice-volume-row">
                <span class="voice-volume-icon">🔉</span>
                <input type="range" class="voice-volume-slider" data-target="${userNickname}"
                    min="0" max="100" value="${Math.round(voiceMesh.getPeerVolume(userNickname) * 100)}">
            </div>
        `;

        row.innerHTML = `
            <img src="${imagePath}" alt="${charName}" onerror="this.src='/data/default_avatar.png'">
            <div class="pname">${charName}</div>
            <div class="pnick">${userNickname}${isMe ? ' (나)' : ''}</div>
            <div class="pcount">${ownedItems.length}개 획득</div>
            ${talkControlHtml}
            ${interrogateHtml}
            ${volumeHtml}
            <div class="participant-items${isOpen ? ' open' : ''}">${thumbsHtml}</div>
        `;

        // 음량 슬라이더 조작 시 voice.js에 바로 반영 (행 클릭 토글이랑 안 겹치게 별도 처리)
        const volumeSlider = row.querySelector('.voice-volume-slider');
        if (volumeSlider) {
            volumeSlider.addEventListener('click', (e) => e.stopPropagation());
            volumeSlider.addEventListener('input', (e) => {
                voiceMesh.setPeerVolume(userNickname, Number(e.target.value) / 100);
            });
        }

        // 행 클릭 시 펼침/접힘 토글 (썸네일/밀담 버튼/음량 슬라이더 클릭은 예외 처리)
        row.addEventListener('click', (e) => {
            if (e.target.closest('.participant-items img') || e.target.closest('.talk-btn') || e.target.closest('.voice-volume-row')) return;
            expandedParticipant = isOpen ? null : userNickname;
            renderCharacterBoard();
        });

        // 밀담/심문 버튼 이벤트 연결 (동시에 둘 다 뜰 수 있어서 전부 개별 연결)
        row.querySelectorAll('.talk-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'end') {
                    socket.emit('end_conversation', { room_id: roomId, nickname });
                } else if (action === 'cancel') {
                    socket.emit('cancel_invite', { room_id: roomId, nickname });
                } else if (action === 'accept' || action === 'invite') {
                    socket.emit('invite_conversation', { room_id: roomId, nickname, target_nickname: btn.dataset.target });
                } else if (action === 'interrogate') {
                    const confirmText = fillTemplate(abilityConfig.action_confirm_text, { target: btn.dataset.target });
                    if (confirm(confirmText)) {
                        socket.emit('request_interrogation', { room_id: roomId, nickname, target_nickname: btn.dataset.target });
                    }
                }
            });
        });

        // 본인 소유 오브젝트는 언제나, 엔딩 공개 이후엔 전원의 오브젝트를 확대보기 가능
        if (canView) {
            row.querySelectorAll('.participant-items img').forEach(imgEl => {
                imgEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const objId = Number(imgEl.dataset.objId);
                    const obj = gameState.objects[objId];
                    if (obj) openZoomModal(obj);
                });
            });
        }

        container.appendChild(row);
    });
}


function renderInventory() {
    const itemsContainer = document.getElementById('inventoryItems');
    const emptyEl = document.getElementById('inventoryEmpty');
    const countEl = document.getElementById('inventoryCount');

    const myConv = findMyConversation();

    const myOwnedItems = Object.values(gameState.objects || {})
        .filter(o => o.owner === nickname)
        .sort((a, b) => a.id - b.id);

    // 밀담 상대가 나에게 보여준(대여해준) 오브젝트도 내 인벤토리에 같이 표시
    const borrowedItems = Object.values(gameState.objects || {})
        .filter(o => o.loaned_to === nickname && o.owner !== nickname)
        .sort((a, b) => a.id - b.id);

    const allItems = [...myOwnedItems, ...borrowedItems];

    countEl.innerText = `${allItems.length}개`;
    itemsContainer.innerHTML = '';

    if (allItems.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    const CLUE_GROUPS = ['location', 'naewoldang', 'interview'];
    const currentPhaseInfo = phasesList[(gameState.phase || 1) - 1];
    const isInvestigation = !!(currentPhaseInfo && currentPhaseInfo.is_investigation);

    allItems.forEach(obj => {
        const isBorrowed = obj.owner !== nickname;      // 상대에게 빌려온 아이템
        const isLoanedOut = obj.owner === nickname && obj.loaned_to; // 내가 상대에게 공개 중인 아이템
        const isClue = CLUE_GROUPS.includes(obj.group);  // 시나리오 정보/설정집이 아닌 실제 단서 오브젝트

        const item = document.createElement('div');
        item.className = 'inv-item' + (obj.group === 'default_map' ? ' inv-item-map' : '');

        let badgeHtml = '';
        if (isBorrowed) badgeHtml = `<div class="inv-badge borrowed">빌려온 아이템</div>`;
        else if (isLoanedOut) badgeHtml = `<div class="inv-badge loaned">상대에게 공개 중</div>`;
        else if (isClue && obj.owner === nickname && !obj.viewed) badgeHtml = `<div class="inv-badge unviewed">아직 미확인</div>`;

        item.innerHTML = `
            <img src="${obj.back_image || obj.front_image}" alt="${obj.type}" onerror="this.src='/data/default_avatar.png'">
            <div class="inv-label">${obj.character_location || obj.location || obj.character_interview || obj.type}</div>
            ${badgeHtml}
        `;

        // 확대보기 - 엔딩 아이템은 상소문 모달로, 일반 단서는 기존 확대보기로 (처음 열람 시 서버에 "확인했음" 기록)
        item.querySelector('img').addEventListener('click', () => {
            if (obj.group === 'default_ending') {
                openEndingModal(obj);
                return;
            }
            openZoomModal(obj);
            if (isClue && obj.owner === nickname && !obj.viewed) {
                socket.emit('mark_object_viewed', { room_id: roomId, nickname, object_id: obj.id });
            }
        });

        // 밀담 중 + 내 소유 + 아직 안 보여준 아이템 → "상대에게 보여주기" 버튼
        // 단, 캐릭터 설정집(default_sheet)은 엔딩 공개 전까지 공유 불가
        // 단서류(CLUE_GROUPS)는 아직 확인 안 해서 되돌려놓을 수 있는 상태면 공유 불가 (완전히 인벤토리에 들어온 것만 공유 가능)
        const isSheet = obj.group === 'default_sheet';
        const isReturnable = isClue && !obj.viewed;
        if (myConv && obj.owner === nickname && !obj.loaned_to && !(isSheet && !isEndingRevealed()) && !isReturnable) {
            const showBtn = document.createElement('button');
            showBtn.className = 'inv-action-btn';
            showBtn.innerText = '상대에게 보여주기';
            showBtn.onclick = (e) => {
                e.stopPropagation();
                socket.emit('show_object_to_partner', { room_id: roomId, nickname, object_id: obj.id });
            };
            item.appendChild(showBtn);
        }

        // 양도 가능(transferable)으로 지정된 특별 아이템 → "건네기" 버튼 (밀담 중에만, 완전히 소유권 이전)
        if (myConv && obj.owner === nickname && obj.transferable && !isReturnable) {
            const giveBtn = document.createElement('button');
            giveBtn.className = 'inv-action-btn give-btn';
            giveBtn.innerText = '🎁 상대에게 건네기';
            giveBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('이 아이템을 상대방에게 완전히 넘기시겠습니까? (되돌리려면 상대가 다시 건네줘야 합니다)')) {
                    socket.emit('give_item_to_partner', { room_id: roomId, nickname, object_id: obj.id });
                }
            };
            item.appendChild(giveBtn);
        }

        // 빌려온 아이템 → "돌려주기" 버튼 (빌린 사람만 가능)
        if (isBorrowed) {
            const returnBtn = document.createElement('button');
            returnBtn.className = 'inv-action-btn';
            returnBtn.innerText = '돌려주기';
            returnBtn.onclick = (e) => {
                e.stopPropagation();
                socket.emit('return_object', { room_id: roomId, nickname, object_id: obj.id });
            };
            item.appendChild(returnBtn);
        }

        // 아직 뒷면 확인 안 한 단서는 조사 시간에 한해 다시 보드로 돌려놓기 가능
        if (isClue && obj.owner === nickname && !obj.viewed && isInvestigation) {
            const unclaimBtn = document.createElement('button');
            unclaimBtn.className = 'inv-action-btn unclaim';
            unclaimBtn.innerText = '다시 놓기';
            unclaimBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('이 오브젝트를 다시 보드에 돌려놓으시겠습니까?')) {
                    socket.emit('unclaim_object', { room_id: roomId, nickname, object_id: obj.id });
                }
            };
            item.appendChild(unclaimBtn);
        }

        itemsContainer.appendChild(item);
    });
}

// ── 확대보기 모달 (긴 내용은 책처럼 페이지 넘기기) ─────────────────────────────
const ZOOM_PAGE_SIZE = 500; // 이 글자 수를 넘으면 여러 페이지로 나눔
let zoomPages = [];
let zoomPageIndex = 0;

function paginateContent(content) {
    if (!content) return [{ heading: '', body: '' }];

    // 백엔드에서 이미 [{heading, body}, ...] 형태로 구조화해서 보낸 경우 그대로 페이지로 사용
    if (Array.isArray(content)) {
        return content.length > 0 ? content : [{ heading: '', body: '' }];
    }

    // 구조화되지 않은 일반 텍스트는 문단 단위로 글자 수 기준 분할
    const paragraphs = content.split(/\n+/);
    const pages = [];
    let current = '';

    paragraphs.forEach(para => {
        const candidate = current ? `${current}\n${para}` : para;
        if (candidate.length > ZOOM_PAGE_SIZE && current.length > 0) {
            pages.push(current.trim());
            current = para;
        } else {
            current = candidate;
        }
    });
    if (current.trim()) pages.push(current.trim());

    const plainPages = pages.length > 0 ? pages : [content];
    return plainPages.map(text => ({ heading: '', body: text }));
}

// 텍스트를 안전하게 HTML로 이스케이프 (innerHTML 조립 시 사용)
function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str == null ? '' : str;
    return div.innerHTML;
}

function renderZoomPage() {
    const page = zoomPages[zoomPageIndex] || { heading: '', body: '' };

    const headingEl = document.getElementById('zoomModalPageHeading');
    if (page.heading) {
        headingEl.innerText = page.heading;
        headingEl.style.display = 'block';
    } else {
        headingEl.style.display = 'none';
    }

    const bodyEl = document.getElementById('zoomModalPageBody');
    const isEmptyPage = !page.heading && !page.body && page.type !== 'timeline';
    bodyEl.parentElement.style.display = isEmptyPage ? 'none' : '';

    if (page.type === 'timeline' && Array.isArray(page.entries)) {
        // 타임라인 전용 UI: 시간 + 행적을 세로 타임라인으로 표시
        bodyEl.classList.add('timeline-list');
        bodyEl.innerHTML = page.entries.map(entry => `
            <div class="timeline-entry">
                <div class="timeline-dot"></div>
                <div class="timeline-body">
                    <div class="timeline-time">${escapeHtml(entry.time)}</div>
                    <div class="timeline-event">${escapeHtml(entry.event)}</div>
                </div>
            </div>
        `).join('');
    } else {
        bodyEl.classList.remove('timeline-list');
        bodyEl.innerText = page.body || '';
    }

    document.getElementById('zoomPageIndicator').innerText = `${zoomPageIndex + 1} / ${zoomPages.length}`;

    const nav = document.getElementById('zoomModalNav');
    nav.classList.toggle('show', zoomPages.length > 1);

    document.getElementById('zoomPrevBtn').disabled = zoomPageIndex === 0;
    document.getElementById('zoomNextBtn').disabled = zoomPageIndex === zoomPages.length - 1;
}

function openZoomModal(obj) {
    const bgEl = document.getElementById('zoomModalBg');
    const scenarioIdForBg = sessionStorage.getItem('scenarioId') || 'scenario_01';

    // location/naewoldang 그룹처럼 그 단서가 속한 "방"이 정의돼 있으면 카드 배경을 그 방 이미지로,
    // 아니면(인터뷰 카드 등) 기존처럼 오브젝트 자체의 back_image를 그대로 사용
    const roomImage = getRoomBackgroundImageForObject(obj);
    const cardBgUrl = roomImage
        ? `/data/${scenarioIdForBg}/images/objects/${roomImage}`
        : (obj.back_image || obj.front_image);

    bgEl.style.backgroundImage = `url('${cardBgUrl}')`;
    // 지도처럼 가로로 넓은 이미지는 cover로 자르면 옆이 잘리니 contain으로 예외 처리
    bgEl.style.backgroundSize = (obj.group === 'default_map') ? 'contain' : 'cover';
    bgEl.style.backgroundRepeat = 'no-repeat';

    const docTitleEl = document.getElementById('zoomModalDocTitle');
    if (obj.doc_title) {
        docTitleEl.innerText = obj.doc_title;
        docTitleEl.style.display = 'block';
    } else {
        docTitleEl.style.display = 'none';
    }

    zoomPages = paginateContent(obj.content);
    zoomPageIndex = 0;
    renderZoomPage();

    document.getElementById('zoomModal').classList.add('open');
}

document.getElementById('zoomPrevBtn').addEventListener('click', () => {
    if (zoomPageIndex > 0) {
        zoomPageIndex -= 1;
        renderZoomPage();
    }
});

document.getElementById('zoomNextBtn').addEventListener('click', () => {
    if (zoomPageIndex < zoomPages.length - 1) {
        zoomPageIndex += 1;
        renderZoomPage();
    }
});

document.getElementById('zoomModalClose').addEventListener('click', () => {
    document.getElementById('zoomModal').classList.remove('open');
});

document.getElementById('zoomModal').addEventListener('click', (e) => {
    if (e.target.id === 'zoomModal') {
        document.getElementById('zoomModal').classList.remove('open');
    }
});

// ── 인벤토리 패널 토글 ─────────────────────────────
function toggleInventory() {
    document.getElementById('inventoryPanel').classList.toggle('open');
}

// ── 페이즈 / 타이머 ─────────────────────────────
function renderPhaseBlock() {
    const phaseIndex = (gameState.phase || 1) - 1; // 0-based
    const phaseInfo = phasesList[phaseIndex];

    const nameEl = document.getElementById('phaseName');
    const noteEl = document.getElementById('phaseNote');
    const advanceBtn = document.getElementById('advancePhaseBtn');
    const gmStatusEl = document.getElementById('gmStatusBanner');

    // 엔딩 공개 여부/방장 연결 상태를 전원에게 표시 (엔딩 공개가 우선)
    if (gmStatusEl) {
        if (isEndingRevealed()) {
            gmStatusEl.style.display = 'block';
            gmStatusEl.className = 'ending-revealed';
            gmStatusEl.innerText = '🔓 엔딩이 공개되었습니다. 이제 모든 참여자의 인벤토리와 보드의 모든 오브젝트를 확인할 수 있습니다.';
        } else if (currentTempGm) {
            gmStatusEl.style.display = 'block';
            gmStatusEl.className = '';
            gmStatusEl.innerText = `⚠️ 방장 연결이 끊겨 ${currentTempGm}님이 임시로 진행을 맡고 있습니다.`;
        } else {
            gmStatusEl.style.display = 'none';
        }
    }

    // 배경음악 트랙 전환: 엔딩이 발표됐으면 그 엔딩의 테마곡, 아니면 현재 페이즈에 지정된 곡
    const scenarioIdForBgm = sessionStorage.getItem('scenarioId') || 'scenario_01';
    console.log('🎵 [bgm check] selected_ending =', gameState.selected_ending, ', theme_track =', gameState.selected_ending_theme_track);
    if (gameState.selected_ending) {
        const themeTrack = myEndingThemeTrack();
        if (themeTrack) {
            console.log('🎵 [bgm switch] 엔딩 테마곡으로 전환 시도:', `/data/${scenarioIdForBgm}/audio/endings/${themeTrack}.mp3`);
            switchBgmTrack(`ending:${themeTrack}`, `/data/${scenarioIdForBgm}/audio/endings/${themeTrack}.mp3`);
        } else {
            console.warn('🎵 [bgm switch] selected_ending은 있는데 theme_track이 없어서 전환 안 함');
        }
    } else if (phaseInfo && phaseInfo.bgm_track) {
        switchBgmTrack(`phase:${phaseInfo.bgm_track}`, `/data/${scenarioIdForBgm}/audio/${phaseInfo.bgm_track}.mp3`);
    } else {
        // 지정된 페이즈 곡도 없고 엔딩도 아직 발표 전 (예: 결과 발표 페이즈 진입 직후) - 이전 곡이 계속 흐르지 않게 정지
        stopBgm();
    }

    if (phaseInfo) {
        nameEl.innerText = `${gameState.phase}. ${phaseInfo.name}`;
        let noteText = phaseInfo.note || '';
        if (phaseInfo.is_investigation) {
            const claimedThisPhase = Object.values(gameState.objects || {})
                .filter(o => o.owner === nickname && o.claimed_phase === gameState.phase).length;
            noteText += ` (내가 획득: ${claimedThisPhase}/${phaseInfo.claim_limit})`;
        }
        noteEl.innerText = noteText;
    } else {
        nameEl.innerText = `${gameState.phase}페이즈`;
        noteEl.innerText = '';
    }

    // 진짜 GM 또는 (GM 연결 끊김 중) 임시 GM만 "다음 단계로 넘어가기" 버튼을 볼 수 있음
    const isGm = currentGm === nickname;
    const isTempGm = currentTempGm === nickname;
    const isLastPhase = phasesList.length > 0 && gameState.phase >= phasesList.length;
    advanceBtn.style.display = ((isGm || isTempGm) && !isLastPhase) ? 'inline-block' : 'none';
    advanceBtn.innerText = isTempGm ? '다음 단계로 넘어가기 ▶ (임시 방장)' : '다음 단계로 넘어가기 ▶';

    // 타이머는 매초 갱신 (setInterval 중복 방지)
    if (timerIntervalId) clearInterval(timerIntervalId);
    updateTimerDisplay();
    timerIntervalId = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
    const timerEl = document.getElementById('phaseTimer');
    const phaseIndex = (gameState.phase || 1) - 1;
    const phaseInfo = phasesList[phaseIndex];

    if (!phaseInfo || phaseInfo.duration_min == null || !gameState.phase_started_at) {
        timerEl.innerText = '--:--';
        timerEl.classList.remove('time-up');
        return;
    }

    const totalSeconds = phaseInfo.duration_min * 60;
    const elapsed = Math.floor(Date.now() / 1000 - gameState.phase_started_at);
    const remaining = totalSeconds - elapsed;

    if (remaining <= 0) {
        const overtime = Math.abs(remaining);
        const m = String(Math.floor(overtime / 60)).padStart(2, '0');
        const s = String(overtime % 60).padStart(2, '0');
        timerEl.innerText = `+${m}:${s}`;
        timerEl.classList.add('time-up');
    } else {
        const m = String(Math.floor(remaining / 60)).padStart(2, '0');
        const s = String(remaining % 60).padStart(2, '0');
        timerEl.innerText = `${m}:${s}`;
        timerEl.classList.remove('time-up');
    }
}

document.getElementById('advancePhaseBtn').addEventListener('click', () => {
    if (confirm('다음 단계로 넘어가시겠습니까? (진행 중인 밀담은 모두 종료됩니다)')) {
        socket.emit('advance_phase', { room_id: roomId, nickname });
    }
});

// 서버가 "아직 단서를 다 못 모은 사람이 있다"고 알려주면(GM에게만 전달됨),
// 명단을 보여주고 그래도 넘길지 다시 확인 → 확인하면 force:true로 재요청
socket.on('phase_advance_incomplete', (data) => {
    const list = (data.incomplete || [])
        .map(u => `· ${u.nickname}: ${u.claimed}/${u.limit}개`)
        .join('\n');
    const proceed = confirm(
        `아직 이번 조사 시간의 단서를 다 모으지 못한 참여자가 있습니다:\n\n${list}\n\n그래도 다음 단계로 넘어가시겠습니까?`
    );
    if (proceed) {
        socket.emit('advance_phase', { room_id: roomId, nickname, force: true });
    }
});

document.getElementById('inventoryToggleBtn').addEventListener('click', toggleInventory);
document.getElementById('inventoryHeader').addEventListener('click', toggleInventory);

// ── 개인 메모장 (게임 종료까지 서버에 저장, 다른 사람에겐 안 보임) ─────────────────────────────
let noteSaveTimeoutId = null;

document.getElementById('noteToggleBtn').addEventListener('click', () => {
    document.getElementById('notePanel').classList.toggle('open');
});

document.getElementById('noteTextarea').addEventListener('input', (e) => {
    const statusEl = document.getElementById('noteSaveStatus');
    statusEl.innerText = '저장 중...';
    clearTimeout(noteSaveTimeoutId);
    noteSaveTimeoutId = setTimeout(() => {
        socket.emit('update_note', { room_id: roomId, nickname, text: e.target.value });
        statusEl.innerText = `저장됨 (${new Date().toLocaleTimeString('ko-KR')})`;
    }, 800); // 타이핑 멈춘 뒤 0.8초 후 저장 (매 키입력마다 서버 부담 주지 않게)
});

// ── GM 전용: 참여자별 오브젝트 획득 현황판 ─────────────────────────────
// (game_state.objects가 이미 다 브로드캐스트되고 있어서, 별도 서버 요청 없이 클라이언트에서 바로 계산)
// 오브젝트 그룹/필드 기준으로 "어느 장소 소속인지" 사람이 읽기 좋은 라벨을 계산
function getObjectLocationLabel(obj) {
    if (obj.group === 'location') return obj.character_location || '알 수 없는 처소';
    if (obj.group === 'naewoldang') return `내월당 - ${obj.location || ''}`;
    if (obj.group === 'interview') return `인터뷰 (${obj.character_interview || ''} 발언)`;
    if (obj.group && obj.group.startsWith('default_')) return '기본 지급';
    return obj.type || '기타';
}

function renderStatusBoard() {
    const listEl = document.getElementById('statusBoardList');
    if (!listEl) return;
    listEl.innerHTML = '';

    Object.entries(selections)
        .filter(([, charName]) => charName)
        .forEach(([nick, charName]) => {
            const items = Object.values(gameState.objects || {})
                .filter(o => o.owner === nick)
                .sort((a, b) => a.id - b.id);

            // 장소 라벨 기준으로 그룹핑
            const byLocation = {};
            items.forEach(o => {
                const label = getObjectLocationLabel(o);
                if (!byLocation[label]) byLocation[label] = [];
                byLocation[label].push(o);
            });

            const groupsHtml = Object.entries(byLocation).map(([label, groupItems]) => {
                const idsText = groupItems.map(o => {
                    if (o.claimed_phase == null) return `${o.id}`;
                    const phaseName = phasesList[o.claimed_phase - 1]?.name;
                    return `${o.id} (${phaseName ? phaseName : `${o.claimed_phase}페이즈`})`;
                }).join(', ');
                return `<div class="sbr-location-group"><span class="sbr-location-label">${label}</span>: ${idsText}</div>`;
            }).join('');

            const row = document.createElement('div');
            row.className = 'status-board-row';
            row.innerHTML = `
                <div class="sbr-name">${charName} (${nick})</div>
                ${items.length > 0 ? groupsHtml : '<div class="sbr-ids">(없음)</div>'}
            `;
            listEl.appendChild(row);
        });
}

document.getElementById('statusBoardToggleBtn').addEventListener('click', () => {
    renderStatusBoard();
    document.getElementById('statusBoardPanel').classList.toggle('open');
});

// ── 이윤 전용: 심문 신청 결과 알림 ─────────────────────────────
socket.on('interrogation_started', (data) => {
    alert(data.msg);
});
socket.on('interrogation_rejected', (data) => {
    alert(data.msg);
});

// 내 밀담 상대가 다른 사람의 심문 대상으로 끌려가서 밀담이 강제 종료됐을 때 알림 (누구에게나 해당 가능)
socket.on('interrogation_partner_taken', (data) => {
    alert(data.msg);
});

// ── GM 전용: 심문 신청 승인/거절 모달 ─────────────────────────────
let pendingInterrogation = null;

socket.on('interrogation_request', (data) => {
    pendingInterrogation = data;
    document.querySelector('#interrogationModalContent h3').innerText = abilityConfig.gm_modal_title;
    document.getElementById('interrogationModalText').innerText = fillTemplate(abilityConfig.gm_modal_text, {
        requester: data.requester,
        requester_character: gameState.special_ability_character || '',
        target_character: data.target_character,
        target: data.target,
    });
    document.getElementById('interrogationModal').classList.add('open');
});

document.getElementById('interrogationAcceptBtn').addEventListener('click', () => {
    socket.emit('respond_interrogation', { room_id: roomId, nickname, decision: 'accept' });
    document.getElementById('interrogationModal').classList.remove('open');
    pendingInterrogation = null;
});

document.getElementById('interrogationRejectBtn').addEventListener('click', () => {
    socket.emit('respond_interrogation', { room_id: roomId, nickname, decision: 'reject' });
    document.getElementById('interrogationModal').classList.remove('open');
    pendingInterrogation = null;
});


// ── 엔딩 발표 (상소문 모달) ─────────────────────────────

// content가 배열(구조화된 페이지)이든 문자열이든, 스크롤로 쭉 읽을 하나의 텍스트로 합침
function flattenEndingContent(content) {
    if (!content) return '';
    if (Array.isArray(content)) {
        return content.map(page => {
            if (page && typeof page === 'object') {
                const heading = page.heading ? `${page.heading}\n\n` : '';
                return heading + (page.body || '');
            }
            return String(page);
        }).join('\n\n\n');
    }
    return String(content);
}

// 인식하는 엔딩 비주얼 테마 → CSS 클래스 매핑. 여기 없는 값(또는 미지정)이면 그냥 기본(수수한 카드형)으로 보임.
const ENDING_THEME_CLASSES = {
    joseon_scroll: 'theme-joseon-scroll',
};

function openEndingModal(ending) {
    const modalEl = document.getElementById('endingModal');
    if (!modalEl) {
        console.error('❌ [openEndingModal] #endingModal을 찾을 수 없습니다 - game.html이 최신 버전인지 확인해주세요 (강력 새로고침 필요할 수 있음)');
        return;
    }

    const imagePath = ending.image || ending.front_image || ending.back_image || '';

    // 상소문 글 뒤로 흐릿하게 비치도록 (종이 배경이 반투명이라 은은하게 겹쳐 보임)
    const scrollEl = document.getElementById('endingScroll');
    if (scrollEl) {
        scrollEl.style.setProperty('--ending-scroll-image', imagePath ? `url('${imagePath}')` : 'none');

        // 시나리오가 지정한 테마 클래스만 남기고 나머지는 정리 (알려지지 않은 값이면 기본 카드형 그대로)
        Object.values(ENDING_THEME_CLASSES).forEach(cls => scrollEl.classList.remove(cls));
        const themeClass = ENDING_THEME_CLASSES[gameState.ending_visual_theme];
        if (themeClass) scrollEl.classList.add(themeClass);
    } else {
        console.warn('⚠️ [openEndingModal] #endingScroll을 찾을 수 없어 배경 이미지는 건너뜁니다');
    }

    const titleEl = document.getElementById('endingScrollTitle');
    if (titleEl) titleEl.innerText = ending.title || ending.doc_title || '엔딩';

    const bodyEl = document.getElementById('endingScrollBody');
    if (bodyEl) bodyEl.innerText = flattenEndingContent(ending.content);

    // 위에서 일부 요소가 없어도, 모달 자체는 반드시 열림
    modalEl.classList.add('open');
}

document.getElementById('endingModalClose').addEventListener('click', () => {
    if (confirm('상소문을 닫으시겠습니까? 닫으면 후기 작성 화면으로 넘어갑니다.')) {
        document.getElementById('endingModal').classList.remove('open');
        // "엔딩 다시보기"로 재열람했을 때도 항상 후기 화면으로 돌아가지도록 명시적으로 다시 열어줌
        // (원래 처음 발표 시엔 결과 화면이 자동으로 이미 열려있지만, "보드로 돌아가기"로 닫아둔 뒤
        //  재열람했다가 닫는 경우엔 뒤에 결과 화면이 없어서 갈 곳이 없어지는 문제를 방지)
        document.getElementById('resultsOverlay').classList.add('open');
    }
});
// 바깥(배경) 클릭으로는 안 닫히게 - 반드시 X 버튼을 눌러야만 닫힘

// 서버가 엔딩을 발표하면 전원에게 자동으로 상소문 모달이 뜸
socket.on('ending_revealed', (ending) => {
    console.log('🏮 [ending_revealed]', ending);
    openEndingModal(ending);
});

// ── GM 전용: 엔딩 판정 (판정값 입력 → 자동 계산 → 확인 후 발표) ─────────────────────────────
// ── GM 전용: 엔딩 판정 폼을 form_fields 스펙 그대로 동적으로 그려주는 범용 렌더러 ─────────────────────────────
// (필드 종류/개수/조건부 노출은 전부 시나리오의 endings.json 안 form_fields에 달려있고, 여기 코드는
//  "select/checkbox/number를 어떻게 그리는지"만 알 뿐, "최다 득표자"가 뭔지는 전혀 모름)
let currentEndingFormFields = [];

function renderEndingFormFields(fields) {
    currentEndingFormFields = fields;
    const container = document.getElementById('endingFormFieldsContainer');
    container.innerHTML = '';

    fields.forEach(field => {
        const wrap = document.createElement('div');
        wrap.className = 'ending-form-field';
        wrap.dataset.fieldKey = field.key;
        if (field.showIf) {
            wrap.dataset.showIfField = field.showIf.field;
            wrap.dataset.showIfSpec = JSON.stringify(field.showIf);
        }

        if (field.type === 'checkbox') {
            wrap.innerHTML = `<label class="ending-form-checkbox-label"><input type="checkbox" data-field-input> ${field.label}</label>`;
        } else if (field.type === 'select') {
            const optionsHtml = (field.options || []).map(opt => {
                const value = typeof opt === 'string' ? opt : opt.value;
                const label = typeof opt === 'string' ? opt : opt.label;
                return `<option value="${value}">${label}</option>`;
            }).join('');
            wrap.innerHTML = `
                <label class="ending-form-label">${field.label}</label>
                <select class="ending-form-select" data-field-input>
                    <option value="">-- 선택 --</option>
                    ${optionsHtml}
                </select>
            `;
        } else if (field.type === 'number') {
            wrap.innerHTML = `
                <label class="ending-form-label">${field.label}</label>
                <input type="number" class="ending-form-number" data-field-input
                    min="${field.min ?? ''}" max="${field.max ?? ''}" value="${field.default ?? 0}">
            `;
        }

        const input = wrap.querySelector('[data-field-input]');
        if (input) input.addEventListener('change', updateEndingFormVisibility);

        container.appendChild(wrap);
    });

    updateEndingFormVisibility(); // showIf가 있는 필드들 초기 표시 여부 반영
}

// showIf 조건을 보고 필드별로 보이거나 숨김 (equals/in 지원)
function updateEndingFormVisibility() {
    const container = document.getElementById('endingFormFieldsContainer');
    const currentValues = collectEndingFormValues();

    container.querySelectorAll('.ending-form-field').forEach(wrap => {
        if (!wrap.dataset.showIfSpec) {
            wrap.style.display = '';
            return;
        }
        const spec = JSON.parse(wrap.dataset.showIfSpec);
        const actual = currentValues[spec.field];
        let visible;
        if ('equals' in spec) visible = actual === spec.equals;
        else if ('in' in spec) visible = spec.in.includes(actual);
        else visible = true;
        wrap.style.display = visible ? '' : 'none';
    });
}

// 현재 폼에 그려진 필드들의 값을 전부 모아서 {key: value} 형태로 반환 (타입에 맞게 변환)
function collectEndingFormValues() {
    const values = {};
    document.querySelectorAll('#endingFormFieldsContainer .ending-form-field').forEach(wrap => {
        const key = wrap.dataset.fieldKey;
        const fieldSpec = currentEndingFormFields.find(f => f.key === key);
        const input = wrap.querySelector('[data-field-input]');
        if (!input || !fieldSpec) return;

        if (fieldSpec.type === 'checkbox') values[key] = input.checked;
        else if (fieldSpec.type === 'number') values[key] = Number(input.value);
        else values[key] = input.value;
    });
    return values;
}

document.getElementById('revealEndingBtn').addEventListener('click', () => {
    // 폼 초기 상태로 리셋
    document.getElementById('endingComputeForm').style.display = 'block';
    document.getElementById('endingComputeResult').style.display = 'none';
    document.getElementById('endingFormFieldsContainer').innerHTML = '';
    document.getElementById('endingPickModal').classList.add('open');

    // 이 시나리오의 판정 폼 스펙을 받아와서 동적으로 그림
    socket.emit('request_ending_form_config', { room_id: roomId, nickname });
    // 예비 경로(직접 목록에서 고르기)에 쓸 제목 목록도 미리 받아둠
    socket.emit('request_ending_list', { room_id: roomId, nickname });
});

socket.on('ending_form_config', (data) => {
    renderEndingFormFields(data.form_fields || []);
});

document.getElementById('computeEndingBtn').addEventListener('click', () => {
    const values = collectEndingFormValues();
    socket.emit('compute_ending', { room_id: roomId, nickname, values });
});

let pendingEndingId = null;

socket.on('ending_computed', (data) => {
    pendingEndingId = data.id;
    document.getElementById('computedEndingTitle').innerText = data.title;
    document.getElementById('endingComputeForm').style.display = 'none';
    document.getElementById('endingComputeResult').style.display = 'block';
});

document.getElementById('recomputeBtn').addEventListener('click', () => {
    document.getElementById('endingComputeForm').style.display = 'block';
    document.getElementById('endingComputeResult').style.display = 'none';
});

document.getElementById('confirmRevealBtn').addEventListener('click', () => {
    if (!pendingEndingId) return;
    if (confirm('이 엔딩을 발표하시겠습니까? 되돌릴 수 없고 전원에게 즉시 공개됩니다.')) {
        socket.emit('reveal_ending', { room_id: roomId, nickname, ending_id: pendingEndingId });
        document.getElementById('endingPickModal').classList.remove('open');
    }
});

// 예비 경로: 직접 목록에서 고르기 (자동 계산이 시나리오와 안 맞을 때 대비)
socket.on('ending_list', (data) => {
    const list = document.getElementById('endingPickList');
    list.innerHTML = '';
    const endings = data.endings || [];

    if (endings.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--ink-muted);">등록된 엔딩이 없습니다. data/{시나리오}/endings.json을 확인해주세요.</div>';
    } else {
        endings.forEach(e => {
            const item = document.createElement('div');
            item.className = 'ending-pick-item';
            item.innerText = e.title;
            item.onclick = () => {
                if (confirm(`"${e.title}" 엔딩을 발표하시겠습니까? 되돌릴 수 없습니다.`)) {
                    socket.emit('reveal_ending', { room_id: roomId, nickname, ending_id: e.id });
                    document.getElementById('endingPickModal').classList.remove('open');
                }
            };
            list.appendChild(item);
        });
    }
});

document.getElementById('endingPickClose').addEventListener('click', () => {
    document.getElementById('endingPickModal').classList.remove('open');
});

// ── 결과 발표 페이지 (참여자 목록 + 후기/난이도/별점/MVP) ─────────────────────────────
let selectedDifficulty = null;
let selectedRating = 0;
let selectedMvpTarget = null;

// 재접속/새로고침 후에도 이미 제출한 내용이 화면에 그대로 보이도록 복원
// (서버가 room_snapshot_sync에 본인 제출값만 개인적으로 실어서 보내줌 - 다른 사람 응답은 여전히 비공개)
function applyMySubmittedFeedback(myFeedback, myMvpVote) {
    if (myFeedback) {
        document.getElementById('reviewTextarea').value = myFeedback.review || '';

        selectedDifficulty = myFeedback.difficulty || null;
        document.querySelectorAll('.difficulty-btn').forEach(b => {
            b.classList.toggle('selected', b.dataset.value === selectedDifficulty);
        });

        selectedRating = myFeedback.rating || 0;
        document.querySelectorAll('#starPicker .star').forEach(s => {
            s.classList.toggle('selected', parseInt(s.dataset.value, 10) <= selectedRating);
        });
    }

    if (myMvpVote) {
        selectedMvpTarget = myMvpVote;
        renderMvpPicker(); // 선택 상태를 반영해서 다시 그림
    }

    if (myFeedback && myMvpVote) {
        document.getElementById('submitFeedbackBtn').disabled = true;
        document.getElementById('feedbackStatus').innerText = '이미 제출하셨습니다. 다른 참여자를 기다리는 중...';
    }
}

function renderResultsParticipants() {
    const container = document.getElementById('resultsParticipantList');
    container.innerHTML = '';
    Object.entries(selections).filter(([, c]) => c).forEach(([nick, charName]) => {
        const chip = document.createElement('div');
        chip.className = 'results-participant-chip';
        chip.innerText = `${charName} (${nick}${nick === nickname ? ' · 나' : ''})`;
        container.appendChild(chip);
    });
}

function renderMvpPicker() {
    const container = document.getElementById('mvpPicker');
    container.innerHTML = '';
    Object.entries(selections)
        .filter(([nick, charName]) => charName && nick !== nickname) // 본인 제외
        .forEach(([nick, charName]) => {
            const btn = document.createElement('button');
            btn.className = 'mvp-pick-btn' + (selectedMvpTarget === nick ? ' selected' : '');
            btn.innerText = `${charName} (${nick})`;
            btn.onclick = () => {
                selectedMvpTarget = nick;
                renderMvpPicker();
            };
            container.appendChild(btn);
        });
}

document.querySelectorAll('.difficulty-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        selectedDifficulty = btn.dataset.value;
        document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.toggle('selected', b === btn));
    });
});

document.querySelectorAll('#starPicker .star').forEach(star => {
    star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.value, 10);
        document.querySelectorAll('#starPicker .star').forEach(s => {
            s.classList.toggle('selected', parseInt(s.dataset.value, 10) <= selectedRating);
        });
    });
});

document.getElementById('submitFeedbackBtn').addEventListener('click', () => {
    const review = document.getElementById('reviewTextarea').value.trim();
    if (!selectedDifficulty) return alert('체감 난이도를 선택해주세요.');
    if (!selectedRating) return alert('별점을 선택해주세요.');
    if (!selectedMvpTarget) return alert('MVP를 선택해주세요.');

    socket.emit('submit_feedback', { room_id: roomId, nickname, review, difficulty: selectedDifficulty, rating: selectedRating });
    socket.emit('vote_mvp', { room_id: roomId, nickname, target_nickname: selectedMvpTarget });

    document.getElementById('submitFeedbackBtn').disabled = true;
    document.getElementById('feedbackStatus').innerText = '제출 완료! 다른 참여자를 기다리는 중...';
});

socket.on('feedback_ack', (data) => {
    document.getElementById('feedbackStatus').innerText = data.msg || '제출되었습니다.';
});
socket.on('mvp_vote_ack', (data) => {
    document.getElementById('feedbackStatus').innerText = data.msg || '제출되었습니다.';
});

function renderRevealedResults(payload) {
    // payload = { latest: {...}, all_playthroughs: [...] } - ending_handler.py에서 이 구조로 보냄
    const allPlaythroughs = payload.all_playthroughs || [payload.latest || payload];

    document.getElementById('resultsRevealed').style.display = 'block';
    document.getElementById('feedbackForm').style.display = 'none';
    document.getElementById('backToBoardBtn').style.display = 'block';

    const boardEl = document.getElementById('playthroughBoard');
    boardEl.innerHTML = '';

    // 최신 팀이 위에 오도록 역순으로 나열
    [...allPlaythroughs].reverse().forEach(pt => {
        const card = document.createElement('div');
        card.className = 'playthrough-card';

        const membersHtml = (pt.participants || []).map(m => `
            <div class="pt-member">
                <div class="pm-head">
                    <span class="pm-name">${m.character || ''} (${m.nickname})${m.is_mvp ? '<span class="pm-mvp-badge">🏆 MVP</span>' : ''}</span>
                    <span class="pm-meta">난이도 ${m.difficulty || '-'} · ${'★'.repeat(m.rating || 0)}${'☆'.repeat(5 - (m.rating || 0))}</span>
                </div>
                <div class="pm-review">${m.review ? m.review.replace(/</g, '&lt;') : '(작성한 후기 없음)'}</div>
            </div>
        `).join('');

        card.innerHTML = `
            <div class="pt-head">
                <span class="pt-date">📅 ${pt.played_at || ''}</span>
                <span class="pt-ending">${pt.selected_ending || ''}</span>
            </div>
            <div class="pt-members">${membersHtml}</div>
        `;
        boardEl.appendChild(card);
    });
}

document.getElementById('backToBoardBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').classList.remove('open');
});

document.getElementById('viewResultsBtn').addEventListener('click', () => {
    document.getElementById('resultsOverlay').classList.add('open');
});

socket.on('results_revealed', (payload) => {
    console.log('🎉 [results_revealed]', payload);
    renderRevealedResults(payload);
});

// GM 전용 - 누가 후기/MVP를 제출했고 안 했는지 실시간 현황
socket.on('submission_status_update', (data) => {
    const listEl = document.getElementById('submissionStatusList');
    if (!listEl) return;
    listEl.innerHTML = '';
    (data.status || []).forEach(s => {
        const row = document.createElement('div');
        row.className = 'submission-status-row';
        row.innerHTML = `
            <span class="ssr-name">${s.character || ''} (${s.nickname})</span>
            <span class="ssr-badges">
                <span class="ssr-badge ${s.feedback_done ? 'done' : 'pending'}">후기 ${s.feedback_done ? '✓' : '대기'}</span>
                <span class="ssr-badge ${s.mvp_done ? 'done' : 'pending'}">MVP ${s.mvp_done ? '✓' : '대기'}</span>
            </span>
        `;
        listEl.appendChild(row);
    });
});

// ── 음성통화 (voice.js 공용 모듈 사용) ─────────────────────────────
// 규칙: 밀담 중이면 그 상대 한 명만, 아니면(GM 포함) 밀담 안 중인 모든 사람과 연결.
// GM은 원래 밀담을 할 수 없는 역할이라 findMyConversation()이 항상 null이라서, 이 규칙 그대로
// GM한테 적용해도 자연스럽게 "GM은 항상 전체 채널에 있다가, 남이 밀담 걸면 그 사람만 자동으로 빠진다"가 됨.
function getDesiredVoicePeers() {
    const myConv = findMyConversation();
    const roomMembers = roomUsers.filter(n => n !== nickname); // 플레이어+GM 전부 포함 (selections 제한 없음)

    if (myConv) {
        return roomMembers.filter(n => myConv.participants.includes(n));
    }
    return roomMembers.filter(n => !findConversationForUser(n));
}

const voiceMesh = createVoiceMesh({
    socket,
    getRoomId: () => roomId,
    getNickname: () => nickname,
    getDesiredPeers: getDesiredVoicePeers,
    onStatusChange: updateVoiceStatusUI,
});

// 화면 하단에 떠있는 음성 상태 표시줄 갱신 (연결된 인원 수 + 음소거 버튼)
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
    document.getElementById('voiceStatusText').innerText = findMyConversation()
        ? `🎙️ 밀담 상대와 음성 연결됨`
        : `🎙️ 전체 채널 음성 연결됨 (${peerCount}명)`;
    document.getElementById('voiceMuteBtn').innerText = voiceMesh.isMuted() ? '🎤 마이크 꺼짐' : '🎤 마이크 끄기';
}

document.getElementById('voiceMuteBtn').addEventListener('click', () => voiceMesh.toggleMute());