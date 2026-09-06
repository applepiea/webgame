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

    function notifyStatusChange() {
        if (onStatusChange) onStatusChange();
    }

    function getOrCreateAudioEl(partnerNickname) {
        let audioEl = document.getElementById(`voiceAudio-${partnerNickname}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `voiceAudio-${partnerNickname}`;
            audioEl.autoplay = true;
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

    async function ensureLocalStream() {
        if (localStream || micPermissionDenied) return localStream;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
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
        if (localStream) {
            localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
        }
        notifyStatusChange();
    }

    return {
        reconcile,
        toggleMute,
        isMuted: () => muted,
        getPeerCount: () => Object.keys(peers).length,
        isMicDenied: () => micPermissionDenied,
    };
}