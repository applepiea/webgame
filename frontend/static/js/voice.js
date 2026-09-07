// ── 음성통화 공용 모듈 (WebRTC, 풀 메시) ─────────────────────────────
// room.js(로비)/game.js(게임 화면) 둘 다 이 모듈을 가져다 씀.
// 이 파일은 "WebRTC 연결을 어떻게 맺고 끊는지"만 알고, "지금 누구와 연결돼 있어야 하는지"는
// 전혀 모름 - 그건 createVoiceMesh()를 호출할 때 getDesiredPeers 콜백으로 호출자가 알려줌.
// (로비는 "방에 있는 모두", 게임 화면은 "밀담 중이면 상대만, 아니면 밀담 안 중인 모두" 등 서로 다른 규칙을 씀)
//
// 서버(Socket.IO)는 "연결 정보"(SDP/ICE)만 상대방에게 중계하고, 실제 음성 데이터는
// 두 브라우저가 직접 주고받음 - 그래서 Cloudflare Tunnel 대역폭이나 우리 서버 성능과 무관함.

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // 무료 공개 STUN (연결 성사만 도와줌, 음성 데이터는 안 거침)

/**
 * 음성 메시(mesh) 관리자를 생성.
 * @param {object} opts
 * @param {object} opts.socket - socket.io 클라이언트 인스턴스
 * @param {() => string} opts.getRoomId
 * @param {() => string} opts.getNickname
 * @param {() => string[]} opts.getDesiredPeers - 지금 연결돼 있어야 할 상대 닉네임 목록을 반환하는 콜백
 * @param {() => void} [opts.onStatusChange] - 연결 상태(인원 수 등)가 바뀔 때마다 호출됨 (상태 UI 갱신용)
 * @returns {{ reconcile: () => Promise<void>, toggleMute: () => void, isMuted: () => boolean, getPeerCount: () => number, isMicDenied: () => boolean }}
 */
export function createVoiceMesh({ socket, getRoomId, getNickname, getDesiredPeers, onStatusChange }) {
    let localStream = null;
    let micPermissionDenied = false;
    let muted = false;
    const peers = {}; // nickname -> { pc: RTCPeerConnection, audioEl: HTMLAudioElement }
    const peerVolumes = {}; // nickname -> 0.0~1.0 (개인별 음량 설정, 연결이 끊겼다 다시 붙어도 유지됨)

    function notifyStatusChange() {
        if (onStatusChange) onStatusChange();
    }

    function getOrCreateAudioEl(partnerNickname) {
        let audioEl = document.getElementById(`voiceAudio-${partnerNickname}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `voiceAudio-${partnerNickname}`;
            audioEl.autoplay = true;
            audioEl.volume = peerVolumes[partnerNickname] ?? 1; // 이전에 조절해둔 음량이 있으면 그대로 적용
            const container = document.getElementById('voiceAudioContainer');
            if (container) container.appendChild(audioEl);
        }
        return audioEl;
    }

    function createPeerConnection(partnerNickname) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit('voice_ice_candidate', {
                    room_id: getRoomId(), nickname: getNickname(), target: partnerNickname, candidate: e.candidate,
                });
            }
        };

        pc.ontrack = (e) => {
            const audioEl = getOrCreateAudioEl(partnerNickname);
            audioEl.srcObject = e.streams[0];
            audioEl.play().catch(() => {
                console.warn(`🎙️ [voice] ${partnerNickname}과의 오디오 자동 재생이 막혔습니다.`);
            });
            if (peers[partnerNickname]) peers[partnerNickname].audioEl = audioEl;
        };

        pc.onconnectionstatechange = () => {
            if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
                closePeer(partnerNickname);
            }
        };

        return pc;
    }

    // 트랙을 피어 연결에 추가하기 직전에, 지금 muted 상태를 다시 한번 강제로 맞춰줌
    // (여러 연결이 같은 트랙 객체를 공유하긴 하지만, 혹시 모를 타이밍 문제에 대비한 이중 안전장치)
    function applyMuteStateToLocalTracks() {
        if (!localStream) return;
        localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
        console.log(`🎙️ [voice] 로컬 트랙 상태 재적용 - muted=${muted}, track.enabled=${!muted}`);
    }

    async function ensureLocalStream() {
        if (localStream || micPermissionDenied) return localStream;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            applyMuteStateToLocalTracks();
        } catch (err) {
            console.warn('🎙️ [voice] 마이크 권한이 없어 음성통화를 사용할 수 없습니다:', err.message);
            micPermissionDenied = true;
        }
        notifyStatusChange();
        return localStream;
    }

    async function initiatePeer(targetNickname) {
        const pc = createPeerConnection(targetNickname);
        peers[targetNickname] = { pc, audioEl: null };
        applyMuteStateToLocalTracks(); // addTrack 직전에 재확인
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voice_call_offer', { room_id: getRoomId(), nickname: getNickname(), target: targetNickname, sdp: offer });
    }

    function closePeer(peerNick) {
        const entry = peers[peerNick];
        if (!entry) return;
        entry.pc.close();
        if (entry.audioEl) entry.audioEl.remove();
        delete peers[peerNick];
        notifyStatusChange();
    }

    async function reconcile() {
        const desired = getDesiredPeers();
        if (desired.length === 0 && Object.keys(peers).length === 0) return; // 할 일 없으면 마이크 권한도 안 물어봄

        await ensureLocalStream();
        if (!localStream) return; // 권한 거부된 상태

        const desiredSet = new Set(desired);

        // 더 이상 연결돼 있을 필요 없는 상대는 정리
        Object.keys(peers).forEach(peerNick => {
            if (!desiredSet.has(peerNick)) closePeer(peerNick);
        });

        // 아직 연결 안 된 필요한 상대는 새로 연결 시도
        // (양쪽 다 이 로직을 동시에 돌리므로, 닉네임을 사전순으로 비교해서 한쪽만 offer를 보내게 함 - 안 그러면 서로 동시에 걸어서 꼬임)
        const myNickname = getNickname();
        desired.forEach(peerNick => {
            if (!peers[peerNick] && myNickname < peerNick) {
                initiatePeer(peerNick);
            }
        });

        notifyStatusChange();
    }

    // ── 소켓 시그널링 수신 ─────────────────────────────
    socket.on('voice_call_offer', async (data) => {
        await ensureLocalStream();
        if (!localStream) return;

        if (peers[data.from]) closePeer(data.from); // 혹시 남아있던 이전 연결이 있으면 정리하고 새로 맺음

        const pc = createPeerConnection(data.from);
        peers[data.from] = { pc, audioEl: null };
        applyMuteStateToLocalTracks(); // addTrack 직전에 재확인
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice_call_answer', { room_id: getRoomId(), nickname: getNickname(), target: data.from, sdp: answer });
        notifyStatusChange();
    });

    socket.on('voice_call_answer', async (data) => {
        const entry = peers[data.from];
        if (!entry) return;
        await entry.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    socket.on('voice_ice_candidate', async (data) => {
        const entry = peers[data.from];
        if (!entry) return;
        try {
            await entry.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
            console.warn('🎙️ [voice] ICE candidate 추가 실패:', err.message);
        }
    });

    socket.on('voice_call_end', (data) => {
        closePeer(data.from);
    });

    function toggleMute() {
        muted = !muted;
        console.log(`🎙️ [voice] 마이크 ${muted ? '끔' : '켬'} (연결된 상대: ${Object.keys(peers).join(', ') || '없음'})`);
        applyMuteStateToLocalTracks();

        // 실제로 각 상대에게 나가는 송신 트랙(sender)의 상태까지 검증 - 여기가 true로 나오면
        // "내 쪽 코드는 맞게 짰는데 실제 전송이 안 막히는" 상황이라 다른 원인을 봐야 함
        Object.entries(peers).forEach(([peerNick, entry]) => {
            entry.pc.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === 'audio') {
                    console.log(`🎙️ [voice] → ${peerNick}로 나가는 송신 트랙 상태: enabled=${sender.track.enabled} (muted=${muted}면 false여야 정상)`);
                }
            });
        });

        notifyStatusChange();
    }

    // 특정 상대의 목소리 크기만 개별 조절 (0.0~1.0). 지금 연결 안 돼있어도 저장해뒀다가,
    // 나중에 연결되면(오디오 엘리먼트 새로 생길 때) 그대로 적용됨.
    function setPeerVolume(peerNickname, volume) {
        peerVolumes[peerNickname] = volume;
        const audioEl = document.getElementById(`voiceAudio-${peerNickname}`);
        if (audioEl) audioEl.volume = volume;
    }

    function getPeerVolume(peerNickname) {
        return peerVolumes[peerNickname] ?? 1;
    }

    // 소켓이 끊겼다 재연결되면(네트워크 순단 등), 이미 죽었을 가능성이 높은 기존 연결들을 전부 정리함.
    // reconcile()은 "peers에 이미 있으면 재연결 시도 안 함"으로 판단하기 때문에, 이 정리를 안 해두면
    // 재연결 후에도 죽은 연결 정보가 남아서 새로 안 걸리는 문제가 생김.
    socket.on('disconnect', () => {
        console.log('🎙️ [voice] 소켓 연결 끊김 - 기존 피어 연결 전부 정리 (재연결 시 새로 맺어짐)');
        Object.keys(peers).forEach(closePeer);
    });

    return {
        reconcile,
        toggleMute,
        isMuted: () => muted,
        getPeerCount: () => Object.keys(peers).length,
        isMicDenied: () => micPermissionDenied,
        setPeerVolume,
        getPeerVolume,
    };
}