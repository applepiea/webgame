// bgm.js - room.html / game.html 공용 배경음악 컨트롤

const BGM_STORAGE_KEY = 'mm_bgm_settings';

function loadBgmSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(BGM_STORAGE_KEY));
        return { muted: false, volume: 0.1, ...(saved || {}) };
    } catch (e) {
        return { muted: false, volume: 0.1 };
    }
}

function saveBgmSettings(settings) {
    try {
        localStorage.setItem(BGM_STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
        // localStorage 접근 실패해도 재생 자체는 계속 되게 조용히 무시
    }
}

/**
 * 배경음악 설정 및 재생 시작.
 * data/{scenarioId}/audio/bgm.mp3 파일이 있으면 자동 재생을 시도하고,
 * 파일이 없으면 컨트롤 자체를 숨김.
 */
export function setupBgm(scenarioId) {
    const audio = document.getElementById('bgmAudio');
    const control = document.getElementById('bgmControl');
    const muteBtn = document.getElementById('bgmMuteBtn');
    const volumeSlider = document.getElementById('bgmVolume');
    const playHint = document.getElementById('bgmPlayHint');

    if (!audio || !control) return;

    const path = `/data/${scenarioId || 'scenario_01'}/audio/bgm.mp3`;

    // 파일이 없으면 컨트롤 자체를 숨김 (단, switchBgmTrack으로 트랙이 바뀐 뒤엔 이 리스너가 다시 안 걸리게 최초 1회만)
    audio.addEventListener('error', () => {
        console.warn(`🎵 배경음악 파일을 찾을 수 없습니다: ${audio.src}`);
    });

    // loop 속성으로 기본 반복 재생을 걸어두지만, 혹시 브라우저 특성상 안 먹힐 경우를 대비해
    // 곡이 끝났을 때(ended) 수동으로도 처음부터 다시 재생하는 이중 안전장치
    audio.addEventListener('ended', () => {
        audio.currentTime = 0;
        audio.play().catch(() => {});
    });

    audio.loop = true;
    audio.src = path;

    const settings = loadBgmSettings();
    audio.volume = settings.volume;
    audio.muted = settings.muted;
    if (volumeSlider) volumeSlider.value = settings.volume;
    if (muteBtn) muteBtn.innerText = settings.muted ? '🔇' : '🔊';

    const tryPlay = () => {
        audio.play().then(() => {
            if (playHint) playHint.style.display = 'none';
        }).catch(() => {
            // 브라우저 자동재생 정책으로 차단된 경우 - 클릭으로 시작할 수 있게 버튼 노출
            if (playHint) playHint.style.display = 'inline-block';
        });
    };
    tryPlay();

    if (playHint) {
        playHint.addEventListener('click', tryPlay);
    }

    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            audio.muted = !audio.muted;
            muteBtn.innerText = audio.muted ? '🔇' : '🔊';
            saveBgmSettings({ muted: audio.muted, volume: audio.volume });
        });
    }

    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const v = parseFloat(volumeSlider.value);
            audio.volume = v;
            if (v > 0 && audio.muted) {
                audio.muted = false;
                if (muteBtn) muteBtn.innerText = '🔊';
            }
            saveBgmSettings({ muted: audio.muted, volume: v });
        });
    }
}

let currentBgmTrackKey = null; // 지금 재생 중인 트랙을 구분하는 키 (같은 트랙으로 또 호출되면 재시작 안 하게)

/**
 * 배경음악을 다른 트랙으로 전환 (페이즈별 곡, 엔딩 캐릭터 테마곡 등).
 * trackKey가 이전과 같으면 아무것도 안 함 (재렌더링마다 곡이 끊겼다 다시 재생되는 것 방지).
 * path가 없으면(해당 트랙 파일이 아직 없는 경우) 지금 재생 중이던 곡을 그대로 유지.
 */
export function switchBgmTrack(trackKey, path) {
    const audio = document.getElementById('bgmAudio');
    if (!audio) { console.warn('🎵 [switchBgmTrack] #bgmAudio 엘리먼트를 못 찾음'); return; }
    if (!path) { console.warn('🎵 [switchBgmTrack] path가 비어있어서 취소'); return; }
    if (trackKey === currentBgmTrackKey) { console.log(`🎵 [switchBgmTrack] 이미 같은 트랙(${trackKey})이라 재시작 안 함`); return; }

    console.log(`🎵 [switchBgmTrack] ${currentBgmTrackKey} → ${trackKey} 전환:`, path);

    // 이전에 재생 중이던 곡을 먼저 확실히 멈추고 되감은 뒤에 새 트랙으로 교체 (겹쳐 재생/전환 꼬임 방지)
    audio.pause();
    audio.currentTime = 0;

    currentBgmTrackKey = trackKey;
    audio.src = path;
    audio.loop = true;

    // stopBgm()이 직전에 일부러 멈춰놨던 상태여도, 새 트랙이 확정되면 무조건 재생을 시도함
    // (음소거 여부는 audio.muted가 따로 관리하므로, 여기선 "일시정지 상태였는지"는 신경 안 씀.
    //  브라우저 자동재생이 막혀있으면 그냥 조용히 실패하고, 기존 "▶ 음악 재생" 버튼으로 시작 가능)
    audio.play().then(() => {
        console.log('🎵 [switchBgmTrack] 재생 성공');
        const playHint = document.getElementById('bgmPlayHint');
        if (playHint) playHint.style.display = 'none';
    }).catch((err) => {
        console.warn('🎵 [switchBgmTrack] 재생 실패(자동재생 차단 가능성):', err.message);
        const playHint = document.getElementById('bgmPlayHint');
        if (playHint) playHint.style.display = 'inline-block';
    });
}

/**
 * 지정된 트랙도 없고 엔딩도 아직 발표 안 된 "공백 구간"(예: 결과 발표 페이즈 진입 직후, 엔딩 발표 전)에
 * 이전 곡이 계속 흘러나오지 않도록 명시적으로 정지시킴.
 */
export function stopBgm() {
    const audio = document.getElementById('bgmAudio');
    if (!audio) return;
    if (currentBgmTrackKey === null && audio.paused) return; // 이미 정지 상태면 아무것도 안 함

    console.log('🎵 [stopBgm] 지정된 트랙 없음 - 재생 중이던 곡 정지');
    audio.pause();
    audio.currentTime = 0;
    currentBgmTrackKey = null; // 다음에 진짜 트랙이 오면 무조건 새로 전환되도록 초기화
}