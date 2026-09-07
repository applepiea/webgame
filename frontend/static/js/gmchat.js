// ── GM 문의 채팅 공용 모듈 ─────────────────────────────
// room.js(로비)/game.js(게임 화면) 둘 다 이 모듈을 가져다 씀.
// 참여자 → GM에게 조용히 문의, GM은 참여자별 스레드를 보고 답장. 완전 비공개(다른 참여자에겐 안 보임).
// 버튼(우측 하단) 누르면 창이 펼쳐지는 방식 - 항상 떠있는 창보다 화면을 덜 차지해서 이 방식으로 고정.

export function createGmChat({ socket, getRoomId, getNickname, getCurrentGm, getDisplayName }) {
    let threads = {};       // 참여자면 자기 스레드만, GM이면 { 닉네임: [메시지,...] } 전체
    let openThread = null;  // GM이 지금 펼쳐서 보고 있는 스레드 (참여자는 항상 자기 자신)
    const unread = {};      // 닉네임 -> 안 읽은 메시지 있는지 (배지 표시용)
    let panelOpen = false;

    const displayName = (nick) => (getDisplayName ? (getDisplayName(nick) || nick) : nick);

    function formatTime(unixSeconds) {
        return new Date(unixSeconds * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.innerText = str == null ? '' : str;
        return div.innerHTML;
    }

    function render() {
        const nickname = getNickname();
        const currentGm = getCurrentGm();
        const isGm = currentGm === nickname;

        const toggleBtn = document.getElementById('gmChatToggleBtn');
        if (!toggleBtn) return; // 이 페이지엔 GM 채팅 UI 자체가 없으면 조용히 무시
        const hasAnyUnread = Object.values(unread).some(Boolean);
        toggleBtn.classList.toggle('has-unread', hasAnyUnread);
        toggleBtn.innerText = isGm ? '📮 문의함' : '💬 GM에게 문의';

        if (!panelOpen) return;

        const threadListEl = document.getElementById('gmChatThreadList');
        const messagesEl = document.getElementById('gmChatMessages');
        const backBtn = document.getElementById('gmChatBackBtn');
        const titleEl = document.getElementById('gmChatTitle');

        if (isGm && !openThread) {
            // GM용 - 스레드 목록 화면
            titleEl.innerText = '문의함';
            backBtn.style.display = 'none';
            messagesEl.style.display = 'none';
            document.getElementById('gmChatInputRow').style.display = 'none';
            threadListEl.style.display = 'block';
            threadListEl.innerHTML = '';

            const threadOwners = Object.keys(threads).filter(n => (threads[n] || []).length > 0);
            if (threadOwners.length === 0) {
                threadListEl.innerHTML = '<div class="gm-chat-empty">아직 문의가 없습니다.</div>';
            }
            threadOwners.forEach(owner => {
                const msgs = threads[owner] || [];
                const last = msgs[msgs.length - 1];
                const item = document.createElement('div');
                item.className = 'gm-chat-thread-item' + (unread[owner] ? ' unread' : '');
                item.innerHTML = `
                    <div class="gct-name">${displayName(owner)} (${owner})${unread[owner] ? ' 🔴' : ''}</div>
                    <div class="gct-preview">${escapeHtml(last ? last.text : '')}</div>
                `;
                item.onclick = () => {
                    openThread = owner;
                    delete unread[owner];
                    render();
                };
                threadListEl.appendChild(item);
            });
            return;
        }

        // 메시지 화면 (참여자는 항상 여기, GM은 특정 스레드를 열었을 때)
        const targetThread = isGm ? openThread : nickname;
        titleEl.innerText = isGm ? `${displayName(targetThread)} (${targetThread})` : 'GM에게 문의';
        backBtn.style.display = isGm ? 'inline-block' : 'none';
        threadListEl.style.display = 'none';
        messagesEl.style.display = 'flex';
        document.getElementById('gmChatInputRow').style.display = 'flex';

        const msgs = threads[targetThread] || [];
        messagesEl.innerHTML = msgs.map(m => {
            const isMine = m.sender_nickname === nickname; // 보낸 사람이 "나"인지 - 역할(GM/참여자)이 아니라 이 기준으로 좌우 결정
            return `
                <div class="gm-chat-msg ${isMine ? 'mine' : 'theirs'}">
                    <span class="gcm-text">${escapeHtml(m.text)}</span>
                    <span class="gcm-time">${formatTime(m.at)}</span>
                </div>
            `;
        }).join('');
        messagesEl.scrollTop = messagesEl.scrollHeight;

        if (!isGm) delete unread[nickname];
    }

    function send() {
        const input = document.getElementById('gmChatInput');
        const text = input.value.trim();
        if (!text) return;

        const nickname = getNickname();
        const isGm = getCurrentGm() === nickname;
        const payload = { room_id: getRoomId(), nickname, text };
        if (isGm) {
            if (!openThread) return;
            payload.target_nickname = openThread;
        }
        socket.emit('send_gm_chat_message', payload);
        input.value = '';
    }

    // ── 소켓 수신 ─────────────────────────────
    socket.on('gm_chat_history', (data) => {
        console.log('📮 [gmchat] 내역 수신:', data.threads, '| isGm =', getCurrentGm() === getNickname());
        threads = data.threads || {};
        render();
    });

    socket.on('gm_chat_message', (data) => {
        const { thread_owner, message } = data;
        console.log('📮 [gmchat] 새 메시지 수신:', data, '| 내 닉네임:', getNickname(), '| GM:', getCurrentGm());
        if (!threads[thread_owner]) threads[thread_owner] = [];
        threads[thread_owner].push(message);

        const nickname = getNickname();
        const isGm = getCurrentGm() === nickname;

        // 참여자가 보낸 새 문의인데 GM 패널이 닫혀있으면, 놓치지 않게 자동으로 열어서 바로 보여줌
        if (isGm && message.sender_nickname !== nickname && !panelOpen) {
            panelOpen = true;
            openThread = thread_owner;
            const panel = document.getElementById('gmChatPanel');
            if (panel) panel.classList.add('open');
        }

        const isViewingThisThread = panelOpen && (openThread === thread_owner || !isGm);
        if (!isViewingThisThread && message.sender_nickname !== nickname) {
            unread[thread_owner] = true;
        }
        render();
    });

    // ── DOM 이벤트 연결 (해당 페이지에 마크업이 있을 때만 동작) ─────────────────────────────
    const toggleBtn = document.getElementById('gmChatToggleBtn');
    console.log('📮 [gmchat] 초기화 - #gmChatToggleBtn 발견:', !!toggleBtn);
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            panelOpen = !panelOpen;
            document.getElementById('gmChatPanel').classList.toggle('open', panelOpen);
            if (!panelOpen) openThread = null; // 닫을 때 목록 화면으로 리셋 (GM 기준)
            render();
        });

        document.getElementById('gmChatCloseBtn').addEventListener('click', () => {
            panelOpen = false;
            openThread = null;
            document.getElementById('gmChatPanel').classList.remove('open');
        });

        document.getElementById('gmChatBackBtn').addEventListener('click', () => {
            openThread = null;
            render();
        });

        document.getElementById('gmChatSendBtn').addEventListener('click', send);
        document.getElementById('gmChatInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') send();
        });
    }

    return {
        requestHistory: () => socket.emit('request_gm_chat_history', { room_id: getRoomId(), nickname: getNickname() }),
        render,
        open: () => {
            panelOpen = true;
            const panel = document.getElementById('gmChatPanel');
            if (panel) panel.classList.add('open');
            render();
        },
    };
}