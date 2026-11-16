'use strict';

(() => {
  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const STORAGE_KEY = 'keryx.messenger.v1';
  const MQTT_PREFIX = 'keryx/v1/';

  /*
   * Signaling runs over public MQTT brokers. Each peer keeps a retained
   * snapshot of its current WebRTC state in its own topic. Public brokers
   * lose or throttle live messages, so while a connection is still being
   * negotiated the clients are reconnected if nothing arrives: a fresh
   * subscription always receives the retained snapshots once.
   */
  const BROKERS = [
    'wss://test.mosquitto.org:8081/mqtt',
    'wss://broker.emqx.io:8084/mqtt'
  ];

  const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
  const MAX_MESSAGES = 300;
  const POLL_INTERVAL = 4000;
  const INVITE_REFRESH = 9000;
  const OFFER_RETRY = 15000;
  const NEGOTIATION_QUIET = 7000;

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function randomString(length, alphabet = ID_ALPHABET) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let result = '';
    for (let index = 0; index < length; index += 1) {
      result += alphabet[bytes[index] % alphabet.length];
    }
    return result;
  }

  function makeSecret() {
    return randomString(24, ID_ALPHABET);
  }

  function sanitizeName(value, fallback = 'Контакт') {
    const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
    return name || fallback;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function formatTime(ts) {
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(ts));
    } catch {
      return '';
    }
  }

  function dayKey(ts) {
    const date = new Date(ts);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function dayLabel(ts) {
    const date = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const diff = Math.round((today - target) / 86400000);
    if (diff === 0) return 'Сегодня';
    if (diff === 1) return 'Вчера';
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long'
    }).format(date);
  }

  function concatBytes(...chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  function u16(value) {
    return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
  }

  function mqttString(value) {
    const bytes = encoder.encode(String(value));
    return concatBytes(u16(bytes.length), bytes);
  }

  function remainingLength(value) {
    const bytes = [];
    let length = value;
    do {
      let byte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) byte |= 128;
      bytes.push(byte);
    } while (length > 0);
    return new Uint8Array(bytes);
  }

  function mqttPacket(type, body) {
    return concatBytes(new Uint8Array([type]), remainingLength(body.length), body);
  }

  /* ------------------------------------------------------------------ */
  /* Minimal MQTT client (WebSocket, QoS 0, retained publishes)          */
  /* ------------------------------------------------------------------ */

  class MqttClient {
    constructor(url, { clientId, onMessage, onStatus }) {
      this.url = url;
      this.clientId = clientId;
      this.onMessage = onMessage;
      this.onStatus = onStatus;
      this.topics = new Set();
      this.socket = null;
      this.connected = false;
      this.connecting = false;
      this.closed = false;
      this.buffer = new Uint8Array(0);
      this.packetId = 1;
      this.retryTimer = null;
      this.pingTimer = null;
      this.connectTimer = null;
      this.lastStatus = false;
    }

    start() {
      this.closed = false;
      this.connect();
    }

    stop() {
      this.closed = true;
      clearTimeout(this.retryTimer);
      this.stopPing();
      clearTimeout(this.connectTimer);
      if (this.socket) {
        try {
          this.socket.close();
        } catch {
          /* Already closed. */
        }
      }
      this.socket = null;
      this.connected = false;
      this.connecting = false;
      this.report(false);
    }

    report(value) {
      if (value === this.lastStatus) return;
      this.lastStatus = value;
      this.onStatus(value);
    }

    scheduleReconnect() {
      if (this.closed) return;
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), 800 + Math.random() * 700);
    }

    connect() {
      if (this.closed || this.connecting) return;
      if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;

      this.connecting = true;
      this.buffer = new Uint8Array(0);

      let socket;
      try {
        socket = new WebSocket(this.url, 'mqtt');
      } catch {
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }

      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      this.connectTimer = setTimeout(() => {
        if (!this.connected) {
          try {
            socket.close();
          } catch {
            /* Already closed. */
          }
        }
      }, 9000);

      socket.onopen = () => {
        const body = concatBytes(
          mqttString('MQTT'),
          new Uint8Array([4, 2, 0, 60]),
          mqttString(this.clientId)
        );
        this.sendPacket(0x10, body);
      };

      socket.onmessage = (event) => {
        this.consume(event.data);
      };

      socket.onerror = () => {
        /* The close handler schedules the retry. */
      };

      socket.onclose = () => {
        clearTimeout(this.connectTimer);
        this.stopPing();
        this.connecting = false;
        this.connected = false;
        this.socket = null;
        this.buffer = new Uint8Array(0);
        this.report(false);
        this.scheduleReconnect();
      };
    }

    sendPacket(type, body) {
      if (!this.socket || this.socket.readyState !== 1) return false;
      try {
        this.socket.send(mqttPacket(type, body));
        return true;
      } catch {
        return false;
      }
    }

    publish(topic, payload, retain = false) {
      if (!this.connected) return;
      const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
      this.sendPacket(
        retain ? 0x31 : 0x30,
        concatBytes(mqttString(topic), bytes)
      );
    }

    subscribe(topic) {
      this.topics.add(topic);
      if (this.connected) this.sendSubscribe(topic);
    }

    restart() {
      if (this.closed) return;
      const socket = this.socket;
      this.socket = null;
      this.connected = false;
      this.connecting = false;
      this.report(false);
      try {
        socket?.close();
      } catch {
        /* Already closed. */
      }
    }

    unsubscribe(topic) {
      this.topics.delete(topic);
      if (!this.connected) return;
      const id = this.nextPacketId();
      this.sendPacket(0xa2, concatBytes(u16(id), mqttString(topic)));
    }

    nextPacketId() {
      this.packetId = (this.packetId % 65535) + 1;
      return this.packetId;
    }

    sendSubscribe(topic) {
      const id = this.nextPacketId();
      this.sendPacket(
        0x82,
        concatBytes(u16(id), mqttString(topic), new Uint8Array([0]))
      );
    }

    startPing() {
      this.stopPing();
      this.pingTimer = setInterval(() => {
        if (this.connected) this.sendPacket(0xc0, new Uint8Array(0));
      }, 20000);
    }

    stopPing() {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    consume(data) {
      const chunk = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer || data);
      this.buffer = concatBytes(this.buffer, chunk);

      while (this.buffer.length >= 2) {
        let multiplier = 1;
        let length = 0;
        let index = 1;
        let byte = 0;

        do {
          if (index >= this.buffer.length) return;
          byte = this.buffer[index];
          length += (byte & 127) * multiplier;
          multiplier *= 128;
          index += 1;
          if (multiplier > 128 * 128 * 128 * 128) return;
        } while (byte & 128);

        if (this.buffer.length < index + length) return;

        const type = this.buffer[0] >> 4;
        const body = this.buffer.slice(index, index + length);
        this.buffer = this.buffer.slice(index + length);
        this.handlePacket(type, body);
      }
    }

    handlePacket(type, body) {
      if (type === 2) {
        clearTimeout(this.connectTimer);
        if (body.length < 2 || body[1] !== 0) {
          try {
            this.socket?.close();
          } catch {
            /* Already closed. */
          }
          return;
        }
        this.connected = true;
        this.connecting = false;
        this.report(true);
        this.startPing();
        for (const topic of this.topics) this.sendSubscribe(topic);
        return;
      }

      if (type === 3) {
        if (body.length < 2) return;
        const topicLength = (body[0] << 8) | body[1];
        if (body.length < 2 + topicLength) return;
        const topic = decoder.decode(body.slice(2, 2 + topicLength));
        const payload = body.slice(2 + topicLength);
        this.onMessage(topic, payload);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Signal bus                                                          */
  /* ------------------------------------------------------------------ */

  class SignalBus {
    constructor(urls, { onMessage, onStatus }) {
      this.handler = onMessage;
      this.statusHandler = onStatus;
      this.online = -1;
      this.lastSnapshotAt = Date.now();
      this.clients = urls.map((url, index) => new MqttClient(url, {
        clientId: `keryx${randomString(9)}${index}`,
        onMessage: (topic, payload) => this.receive(topic, payload),
        onStatus: () => this.report()
      }));
    }

    start() {
      for (const client of this.clients) client.start();
    }

    ensureConnected() {
      for (const client of this.clients) {
        if (client.closed || client.connected || client.connecting) continue;
        if (client.socket) continue;
        client.connect();
      }
    }

    isOnline() {
      return this.clients.some((client) => client.connected);
    }

    report() {
      const online = this.clients.filter((client) => client.connected).length;
      if (online === this.online) return;
      this.online = online;
      this.statusHandler(online, this.clients.length);
    }

    subscribe(topic) {
      for (const client of this.clients) client.subscribe(MQTT_PREFIX + topic);
    }

    unsubscribe(topic) {
      for (const client of this.clients) client.unsubscribe(MQTT_PREFIX + topic);
    }

    /*
     * Nothing signaling-related arrived for a while. Reconnecting is cheaper
     * than repeatedly subscribing: public brokers rate-limit SUBSCRIBE and
     * silently stop delivering, but a fresh connection always gets the
     * retained snapshot replayed once.
     */
    restartQuiet(maxQuiet) {
      if (Date.now() - this.lastSnapshotAt < maxQuiet) return;
      this.lastSnapshotAt = Date.now();
      for (const client of this.clients) {
        if (client.closed || !client.connected) continue;
        client.restart();
      }
    }

    publish(topic, message, { retain = false } = {}) {
      let payload;

      if (typeof message === 'string' || message instanceof Uint8Array) {
        payload = message;
      } else {
        if (!message.id) message.id = randomString(12);
        if (!message.ts) message.ts = Date.now();
        payload = JSON.stringify(message);
      }

      for (const client of this.clients) {
        client.publish(MQTT_PREFIX + topic, payload, retain);
      }
    }

    publishRaw(topic, payload, { retain = false } = {}) {
      for (const client of this.clients) {
        client.publish(MQTT_PREFIX + topic, payload, retain);
      }
    }

    receive(fullTopic, payload) {
      if (!fullTopic.startsWith(MQTT_PREFIX)) return;
      const topic = fullTopic.slice(MQTT_PREFIX.length);
      const parts = topic.split('/');

      /* <room>/s/<peerId> — one retained snapshot per peer. */
      if (parts.length !== 3 || parts[1] !== 's') return;

      this.lastSnapshotAt = Date.now();
      this.handler(parts[0], payload);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Persistent state                                                    */
  /* ------------------------------------------------------------------ */

  function loadState() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
      stored = {};
    }

    const profile = stored.profile && typeof stored.profile === 'object'
      ? stored.profile
      : {};

    const id = typeof profile.id === 'string' && profile.id.length >= 6
      ? profile.id
      : `k${randomString(10)}`;

    const name = sanitizeName(profile.name, `Гость-${id.slice(-4).toUpperCase()}`);

    const contacts = Array.isArray(stored.contacts)
      ? stored.contacts
        .filter((contact) => contact && typeof contact.id === 'string' && contact.id !== id)
        .map((contact) => ({
          id: contact.id,
          name: sanitizeName(contact.name, 'Контакт'),
          secret: typeof contact.secret === 'string' ? contact.secret : '',
          addedAt: Number(contact.addedAt) || Date.now()
        }))
      : [];

    const messages = {};
    if (stored.messages && typeof stored.messages === 'object') {
      for (const [peerId, list] of Object.entries(stored.messages)) {
        if (!Array.isArray(list)) continue;
        messages[peerId] = list
          .filter((message) => message && typeof message.text === 'string')
          .slice(-MAX_MESSAGES)
          .map((message) => ({
            id: String(message.id || randomString(10)),
            from: message.from === 'me' ? 'me' : 'them',
            text: String(message.text).slice(0, 4000),
            ts: Number(message.ts) || Date.now()
          }));
      }
    }

    const activePeerId = typeof stored.activePeerId === 'string'
      && contacts.some((contact) => contact.id === stored.activePeerId)
      ? stored.activePeerId
      : null;

    return { profile: { id, name }, contacts, messages, activePeerId, unread: {} };
  }

  const state = loadState();

  const el = {
    netPill: $('netPill'),
    netText: $('netText'),
    netLabel: $('netLabel'),
    inviteCode: $('inviteCode'),
    copyCodeBtn: $('copyCodeBtn'),
    newCodeBtn: $('newCodeBtn'),
    enterCodeBtn: $('enterCodeBtn'),
    addFriendBtn: $('addFriendBtn'),
    addFriendRail: $('addFriendRail'),
    contacts: $('contacts'),
    contactsEmpty: $('contactsEmpty'),
    contactCount: $('contactCount'),
    railBadge: $('railBadge'),
    myAvatar: $('myAvatar'),
    myName: $('myName'),
    profileBtn: $('profileBtn'),
    editNameBtn: $('editNameBtn'),
    chatEmpty: $('chatEmpty'),
    emptyAddBtn: $('emptyAddBtn'),
    chatHead: $('chatHead'),
    peerAvatar: $('peerAvatar'),
    peerName: $('peerName'),
    peerStatus: $('peerStatus'),
    peerStatusText: $('peerStatusText'),
    deleteContactBtn: $('deleteContactBtn'),
    messages: $('messages'),
    composer: $('composer'),
    messageInput: $('messageInput'),
    sendBtn: $('sendBtn'),
    codeDialog: $('codeDialog'),
    codeForm: $('codeForm'),
    codeInput: $('codeInput'),
    codeStatus: $('codeStatus'),
    connectCodeBtn: $('connectCodeBtn'),
    closeCodeDialog: $('closeCodeDialog'),
    cancelCodeBtn: $('cancelCodeBtn'),
    nameDialog: $('nameDialog'),
    nameForm: $('nameForm'),
    nameInput: $('nameInput'),
    closeNameDialog: $('closeNameDialog'),
    cancelNameBtn: $('cancelNameBtn'),
    toast: $('toast')
  };

  let invite = null;
  let joinState = null;
  let toastTimer = null;

  const connections = new Map();
  const watchedRooms = new Map();
  let pollTimer = null;

  const bus = new SignalBus(BROKERS, {
    onMessage: handleRoomMessage,
    onStatus: updateNetworkStatus
  });

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        profile: state.profile,
        contacts: state.contacts,
        messages: state.messages,
        activePeerId: state.activePeerId
      }));
    } catch {
      /* Storage can be unavailable; the session still works. */
    }
  }

  function activeContact() {
    return state.contacts.find((contact) => contact.id === state.activePeerId) || null;
  }

  function contactByRoom(room) {
    if (!room.startsWith('c-')) return null;
    const secret = room.slice(2);
    return state.contacts.find((contact) => contact.secret === secret) || null;
  }

  function isOnline(peerId) {
    const connection = connections.get(peerId);
    return Boolean(
      connection
      && connection.status === 'online'
      && connection.dc
      && connection.dc.readyState === 'open'
    );
  }

  /* ------------------------------------------------------------------ */
  /* UI: network, toast, avatars                                         */
  /* ------------------------------------------------------------------ */

  function updateNetworkStatus(online, total) {
    el.netPill.classList.toggle('is-online', online > 0);
    el.netPill.classList.toggle('is-offline', online === 0);
    el.netText.textContent = online > 0 ? 'сеть' : 'офлайн';

    if (online > 0) {
      el.netLabel.textContent = `P2P-сеть готова · ${online}/${total}`;
    } else {
      el.netLabel.textContent = 'Нет связи с сигнальной сетью…';
    }
  }

  function showToast(message, type = '') {
    clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.className = `toast${type === 'error' ? ' is-error' : ''}`;
    el.toast.hidden = false;
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 3200);
  }

  function renderProfile() {
    el.myName.textContent = state.profile.name;
    el.myAvatar.textContent = initials(state.profile.name);
  }

  /* ------------------------------------------------------------------ */
  /* UI: contacts                                                        */
  /* ------------------------------------------------------------------ */

  function renderContacts() {
    el.contactCount.textContent = String(state.contacts.length);
    el.contactsEmpty.hidden = state.contacts.length > 0;

    const fragment = document.createDocumentFragment();

    for (const contact of state.contacts) {
      const connection = connections.get(contact.id);
      const online = isOnline(contact.id);
      const connecting = Boolean(
        connection
        && connection.status === 'connecting'
        && !online
      );
      const unread = state.unread[contact.id] || 0;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `contact${contact.id === state.activePeerId ? ' is-active' : ''}`;
      button.dataset.id = contact.id;
      button.setAttribute('role', 'listitem');

      const avatar = document.createElement('span');
      avatar.className = 'avatar avatar-sm';
      avatar.textContent = initials(contact.name);

      const copy = document.createElement('span');
      copy.className = 'contact-copy';

      const name = document.createElement('span');
      name.className = 'contact-name';
      name.textContent = contact.name;

      const status = document.createElement('span');
      status.className = 'contact-status';
      if (online) status.classList.add('is-online');
      else if (connecting) status.classList.add('is-connecting');

      const dot = document.createElement('span');
      dot.className = 'status-dot';
      if (online) dot.classList.add('is-online');
      else if (connecting) dot.classList.add('is-connecting');

      const statusText = document.createElement('span');
      statusText.textContent = online
        ? 'В сети'
        : connecting
          ? 'Подключение…'
          : 'Не в сети';

      status.append(dot, statusText);
      copy.append(name, status);
      button.append(avatar, copy);

      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'unread-badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        button.appendChild(badge);
      }

      fragment.appendChild(button);
    }

    el.contacts.replaceChildren(fragment);

    const totalUnread = state.contacts
      .filter((contact) => contact.id !== state.activePeerId)
      .reduce((sum, contact) => sum + (state.unread[contact.id] || 0), 0);

    el.railBadge.hidden = totalUnread === 0;
    el.railBadge.textContent = totalUnread > 99 ? '99+' : String(totalUnread);
  }

  function setActiveContact(peerId) {
    const contact = state.contacts.find((item) => item.id === peerId);
    if (!contact) return;

    state.activePeerId = peerId;
    state.unread[peerId] = 0;
    saveState();
    renderContacts();
    renderChat();
    syncRooms();
  }

  /* ------------------------------------------------------------------ */
  /* UI: chat                                                            */
  /* ------------------------------------------------------------------ */

  function updateChatAvailability(contact) {
    const online = isOnline(contact.id);
    const connection = connections.get(contact.id);
    const connecting = Boolean(connection && connection.status === 'connecting');
    const statusDot = el.peerStatus.querySelector('.status-dot');

    el.peerStatusText.textContent = online
      ? 'В сети · прямой канал'
      : connecting
        ? 'Подключение…'
        : 'Не в сети';

    statusDot.className = 'status-dot';
    if (online) statusDot.classList.add('is-online');
    else if (connecting) statusDot.classList.add('is-connecting');

    el.messageInput.disabled = !online;
    el.sendBtn.disabled = !online;
    el.composer.classList.toggle('is-offline', !online);
    el.messageInput.placeholder = online
      ? 'Написать сообщение…'
      : connecting
        ? 'Устанавливаем прямое соединение…'
        : 'Контакт не в сети — сообщение отправить нельзя';
  }

  function renderMessages(contact) {
    const list = state.messages[contact.id] || [];
    const fragment = document.createDocumentFragment();

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'messages-empty';

      const title = document.createElement('strong');
      title.textContent = `Это начало переписки с ${contact.name}`;

      const hint = document.createElement('span');
      hint.textContent = 'Сообщения передаются напрямую и не хранятся на сервере.';

      empty.append(title, hint);
      fragment.appendChild(empty);
    } else {
      let lastDay = '';
      for (const message of list) {
        const key = dayKey(message.ts);
        if (key !== lastDay) {
          lastDay = key;
          const divider = document.createElement('div');
          divider.className = 'date-divider';
          divider.textContent = dayLabel(message.ts);
          fragment.appendChild(divider);
        }

        const row = document.createElement('div');
        row.className = `message${message.from === 'me' ? ' is-mine' : ''}`;

        const avatar = document.createElement('span');
        avatar.className = 'avatar avatar-sm';
        avatar.textContent = initials(message.from === 'me' ? state.profile.name : contact.name);

        const copy = document.createElement('div');
        copy.className = 'message-copy';

        const meta = document.createElement('div');
        meta.className = 'message-meta';

        const author = document.createElement('span');
        author.className = 'message-author';
        author.textContent = message.from === 'me' ? state.profile.name : contact.name;

        const time = document.createElement('time');
        time.className = 'message-time';
        time.dateTime = new Date(message.ts).toISOString();
        time.textContent = formatTime(message.ts);

        const text = document.createElement('p');
        text.className = 'message-text';
        text.textContent = message.text;

        meta.append(author, time);
        copy.append(meta, text);
        row.append(avatar, copy);
        fragment.appendChild(row);
      }
    }

    el.messages.replaceChildren(fragment);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function renderChat() {
    const contact = activeContact();

    if (!contact) {
      el.chatEmpty.hidden = false;
      el.chatHead.hidden = true;
      el.messages.hidden = true;
      el.composer.hidden = true;
      return;
    }

    el.chatEmpty.hidden = true;
    el.chatHead.hidden = false;
    el.messages.hidden = false;
    el.composer.hidden = false;

    el.peerName.textContent = contact.name;
    el.peerAvatar.textContent = initials(contact.name);

    updateChatAvailability(contact);
    renderMessages(contact);
  }

  /* ------------------------------------------------------------------ */
  /* Room polling                                                        */
  /* ------------------------------------------------------------------ */

  function snapshotTopic(room) {
    return `${room}/s/${state.profile.id}`;
  }

  function watchRoom(room) {
    if (watchedRooms.has(room)) return;
    const topic = `${room}/s/+`;
    watchedRooms.set(room, true);
    bus.subscribe(topic);
  }

  function unwatchRoom(room) {
    if (!watchedRooms.has(room)) return;
    watchedRooms.delete(room);
    bus.unsubscribe(`${room}/s/+`);
  }

  function syncRooms() {
    const wanted = new Set();

    if (invite) wanted.add(invite.topic);
    if (joinState) wanted.add(joinState.room);

    for (const contact of state.contacts) {
      if (!contact.secret) continue;
      if (!isOnline(contact.id)) wanted.add(`c-${contact.secret}`);
    }

    for (const room of [...watchedRooms.keys()]) {
      if (!wanted.has(room)) unwatchRoom(room);
    }

    for (const room of wanted) watchRoom(room);
  }

  /* ------------------------------------------------------------------ */
  /* Snapshot signaling                                                  */
  /* ------------------------------------------------------------------ */

  /*
   * Public brokers throttle or silently drop payloads above roughly 1 KB,
   * so snapshots are gzipped and base64-encoded before publishing. Both
   * the SDP and its ICE candidates travel in a single compressed blob.
   */
  const MAX_SNAPSHOT_BYTES = 1000;

  async function encodeSnapshot(object) {
    const json = JSON.stringify(object);

    if (typeof CompressionStream !== 'function') return encoder.encode(json);

    try {
      const compressed = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Uint8Array(await new Response(compressed).arrayBuffer());
    } catch {
      return encoder.encode(json);
    }
  }

  async function decodeSnapshot(raw) {
    const bytes = raw instanceof Uint8Array ? raw : encoder.encode(String(raw || ''));

    if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
    }

    return JSON.parse(decoder.decode(bytes));
  }

  function waitForIceGathering(pc, timeout) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(finish, timeout);
      pc.addEventListener('icegatheringstatechange', onChange);
    });
  }

  async function publishSnapshot(connection, { force = false } = {}) {
    if (connection.closed || connection.status === 'online') return;
    if (!connection.localKind || !connection.pc.localDescription) return;

    /*
     * Public brokers rate-limit aggressive publishers, so an unchanged
     * snapshot is only refreshed as a slow heartbeat. The peer also pulls
     * the retained copy on every poll.
     */
    const signature = `${connection.localKind}|${connection.pc.localDescription.sdp}`;
    const fresh = Date.now() - (connection.lastPublishAt || 0) < 8000;
    if (!force && connection.lastSignature === signature && fresh) return;

    const payload = await encodeSnapshot({
      kind: connection.localKind,
      from: state.profile.id,
      name: state.profile.name,
      room: connection.room,
      session: connection.sessionStartedAt,
      pairSecret: connection.secret || undefined,
      sdp: connection.pc.localDescription
    });

    if (connection.closed || connection.status === 'online') return;

    connection.lastSignature = signature;
    connection.lastPublishAt = Date.now();

    bus.publish(snapshotTopic(connection.room), payload, { retain: true });

    if (payload.length > MAX_SNAPSHOT_BYTES) {
      console.warn('[Keryx] snapshot is large', payload.length);
    }
  }

  function scheduleSnapshot(connection) {
    if (connection.snapshotTimer || connection.closed) return;

    connection.snapshotTimer = setTimeout(() => {
      connection.snapshotTimer = null;
      publishSnapshot(connection);
    }, 400);
  }

  function clearSnapshot(room) {
    bus.publishRaw(snapshotTopic(room), '', { retain: true });
  }

  async function handleRoomMessage(room, raw) {
    let message;
    try {
      message = await decodeSnapshot(raw);
    } catch {
      return;
    }

    if (!message || typeof message !== 'object') return;
    if (typeof message.kind !== 'string' || typeof message.from !== 'string') return;
    if (message.from === state.profile.id) return;
    if (message.room && message.room !== room) return;

    if (message.kind === 'invite') {
      handleRemoteInvite(room, message);
    } else if (message.kind === 'offer') {
      handleRemoteOffer(room, message);
    } else if (message.kind === 'answer') {
      handleRemoteAnswer(message);
    }
  }

  function handleRemoteInvite(room, message) {
    if (!joinState || joinState.room !== room) return;
    if (joinState.ownerId) return;

    const ownerId = message.from;
    joinState.ownerId = ownerId;
    joinState.ownerName = sanitizeName(message.name, 'Контакт');
    joinState.phase = 'connecting';

    setCodeStatus('Друг найден. Устанавливаем прямое соединение…', 'ok');

    startOffer(ownerId, room, {
      name: joinState.ownerName,
      secret: makeSecret(),
      session: Date.now()
    }).catch(() => {
      setCodeStatus('Не удалось начать соединение. Попробуйте ещё раз.', 'error');
    });
  }

  function handleRemoteOffer(room, message) {
    if (!message.sdp || typeof message.sdp !== 'object') return;

    const peerId = message.from;
    const session = Number(message.session) || 0;
    const existing = connections.get(peerId);

    /*
     * Retained offers are replayed on every poll, so the same snapshot may
     * arrive many times. Only a newer session may replace a live connection.
     */
    if (existing && !existing.closed && session <= existing.sessionStartedAt) {
      if (existing.localKind === 'answer' && !isOnline(peerId)) {
        publishSnapshot(existing);
      }
      return;
    }

    const contact = contactByRoom(room);
    const isJoinRoom = Boolean(joinState && joinState.room === room);
    const isInviteRoom = Boolean(invite && invite.topic === room);

    if (!contact && !isJoinRoom && !isInviteRoom) return;

    if (existing) cleanupConnection(existing);

    const connection = createConnection(peerId, room, {
      initiator: false,
      name: sanitizeName(message.name, contact?.name || 'Контакт'),
      secret: contact?.secret || message.pairSecret || '',
      session: session || Date.now()
    });

    acceptOffer(connection, message);
  }

  async function acceptOffer(connection, message) {
    try {
      await connection.pc.setRemoteDescription(message.sdp);

      const answer = await connection.pc.createAnswer();
      await connection.pc.setLocalDescription(answer);
      await waitForIceGathering(connection.pc, 2500);

      if (connection.closed) return;
      connection.localKind = 'answer';
      publishSnapshot(connection, { force: true });

      if (joinState && connection.room === joinState.room) {
        setCodeStatus('Друг найден. Устанавливаем прямое соединение…', 'ok');
      }
    } catch (error) {
      console.error('[Keryx] answer failed', error);
      markDisconnected(connection);
    }
  }

  async function handleRemoteAnswer(message) {
    if (!message.sdp) return;

    const connection = connections.get(message.from);
    if (!connection || connection.localKind !== 'offer') return;
    if (Number(message.session) !== connection.sessionStartedAt) return;

    if (connection.pc.signalingState === 'have-local-offer') {
      try {
        await connection.pc.setRemoteDescription(message.sdp);
      } catch (error) {
        console.error('[Keryx] remote answer failed', error);
        return;
      }
    }
  }

  async function startOffer(peerId, room, { name, secret, session }) {
    const connection = createConnection(peerId, room, {
      initiator: true,
      name,
      secret,
      session
    });

    try {
      const offer = await connection.pc.createOffer();
      await connection.pc.setLocalDescription(offer);
      await waitForIceGathering(connection.pc, 2500);

      if (connection.closed) return connection;
      connection.localKind = 'offer';
      publishSnapshot(connection, { force: true });
    } catch (error) {
      console.error('[Keryx] offer failed', error);
      markDisconnected(connection);
    }

    return connection;
  }

  /* ------------------------------------------------------------------ */
  /* Connections                                                         */
  /* ------------------------------------------------------------------ */

  function cleanupConnection(connection) {
    if (!connection || connection.closed) return;
    connection.closed = true;
    clearTimeout(connection.disconnectTimer);
    clearTimeout(connection.snapshotTimer);

    try {
      connection.dc?.close();
    } catch {
      /* Already closed. */
    }

    try {
      connection.pc?.close();
    } catch {
      /* Already closed. */
    }

    if (connections.get(connection.peerId) === connection) {
      connections.delete(connection.peerId);
    }
  }

  function createConnection(peerId, room, { initiator, name, secret, session }) {
    const existing = connections.get(peerId);
    if (existing) cleanupConnection(existing);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const connection = {
      peerId,
      room,
      name: sanitizeName(name, 'Контакт'),
      secret,
      initiator,
      pc,
      dc: null,
      localKind: null,
      snapshotTimer: null,
      sessionStartedAt: session || Date.now(),
      status: 'connecting',
      createdAt: Date.now(),
      closed: false,
      disconnectTimer: null
    };

    connections.set(peerId, connection);
    wirePeerConnection(connection);

    if (initiator) {
      const dc = pc.createDataChannel('keryx', { ordered: true });
      wireDataChannel(connection, dc);
    }

    renderContacts();
    if (activeContact()?.id === peerId) renderChat();
    syncRooms();
    return connection;
  }

  function wirePeerConnection(connection) {
    const { pc } = connection;

    pc.onicegatheringstatechange = () => {
      if (connection.closed || connection.status === 'online') return;
      if (pc.iceGatheringState === 'complete' && connection.localKind) {
        scheduleSnapshot(connection);
      }
    };

    pc.ondatachannel = (event) => {
      wireDataChannel(connection, event.channel);
    };

    pc.onconnectionstatechange = () => {
      if (connection.closed) return;

      if (pc.connectionState === 'failed') {
        markDisconnected(connection);
      } else if (pc.connectionState === 'disconnected') {
        clearTimeout(connection.disconnectTimer);
        connection.disconnectTimer = setTimeout(() => {
          if (!connection.closed && pc.connectionState === 'disconnected') {
            markDisconnected(connection);
          }
        }, 4000);
      } else if (pc.connectionState === 'connected') {
        clearTimeout(connection.disconnectTimer);
      }
    };
  }

  function wireDataChannel(connection, channel) {
    if (connection.dc && connection.dc !== channel) {
      try {
        connection.dc.close();
      } catch {
        /* Already closed. */
      }
    }

    connection.dc = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (connection.closed) return;
      connection.status = 'online';
      onConnectionOpen(connection);
    };

    channel.onclose = () => {
      markDisconnected(connection);
    };

    channel.onerror = () => {
      /* handled by close */
    };

    channel.onmessage = (event) => {
      handleChannelMessage(connection, event.data);
    };
  }

  function markDisconnected(connection) {
    if (!connection || connection.closed) return;
    const peerId = connection.peerId;
    cleanupConnection(connection);
    renderContacts();
    if (activeContact()?.id === peerId) renderChat();
    syncRooms();
  }

  function onConnectionOpen(connection) {
    const contact = state.contacts.find((item) => item.id === connection.peerId);

    if (!contact) {
      state.contacts.push({
        id: connection.peerId,
        name: connection.name,
        secret: connection.secret || '',
        addedAt: Date.now()
      });
      showToast(`Контакт добавлен: ${connection.name}`);
      if (!state.activePeerId) state.activePeerId = connection.peerId;
    } else {
      if (connection.name && connection.name !== 'Контакт') contact.name = connection.name;
      if (connection.secret) contact.secret = connection.secret;
    }

    if (joinState && connection.room === joinState.room) {
      joinState = null;
      if (el.codeDialog.open) el.codeDialog.close();
      setCodeStatus('');
    }

    if (connection.room.startsWith('i-')) {
      clearSnapshot(connection.room);
      unwatchRoom(connection.room);
      if (invite?.topic === connection.room) setInviteCode();
    }

    try {
      connection.dc?.send(JSON.stringify({
        kind: 'profile',
        id: state.profile.id,
        name: state.profile.name
      }));
    } catch {
      /* The channel may have closed immediately. */
    }

    saveState();
    renderContacts();
    syncRooms();
    renderChat();
  }

  /* ------------------------------------------------------------------ */
  /* Contact reconnection                                                */
  /* ------------------------------------------------------------------ */

  function maybeInitiateContact(contact) {
    if (!contact?.secret) return;
    if (state.profile.id >= contact.id) return;
    if (isOnline(contact.id)) return;

    const existing = connections.get(contact.id);
    const now = Date.now();

    if (existing && !existing.closed) {
      if (now - existing.sessionStartedAt < OFFER_RETRY) return;
      cleanupConnection(existing);
    }

    startOffer(contact.id, `c-${contact.secret}`, {
      name: contact.name,
      secret: contact.secret,
      session: now
    }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Data channel messages                                               */
  /* ------------------------------------------------------------------ */

  function handleChannelMessage(connection, raw) {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (!data || typeof data !== 'object') return;

    if (data.kind === 'profile') {
      const name = sanitizeName(data.name, connection.name);
      connection.name = name;
      const contact = state.contacts.find((item) => item.id === connection.peerId);
      if (contact && name !== contact.name) {
        contact.name = name;
        saveState();
        renderContacts();
        if (state.activePeerId === contact.id) renderChat();
      }
      return;
    }

    if (data.kind !== 'chat') return;

    const contact = state.contacts.find((item) => item.id === connection.peerId);
    if (!contact) return;

    const text = typeof data.text === 'string' ? data.text.slice(0, 4000) : '';
    if (!text.trim()) return;

    const message = {
      id: String(data.id || randomString(10)),
      from: 'them',
      text,
      ts: Number(data.ts) || Date.now()
    };

    appendMessage(contact.id, message);

    if (state.activePeerId === contact.id) {
      renderChat();
    } else {
      state.unread[contact.id] = (state.unread[contact.id] || 0) + 1;
      renderContacts();
    }
  }

  function appendMessage(peerId, message) {
    const list = state.messages[peerId] || [];
    list.push(message);
    if (list.length > MAX_MESSAGES) list.splice(0, list.length - MAX_MESSAGES);
    state.messages[peerId] = list;
    saveState();
  }

  function sendMessage() {
    const contact = activeContact();
    if (!contact) return;

    const text = el.messageInput.value.trim();
    if (!text) return;

    const connection = connections.get(contact.id);
    if (!isOnline(contact.id) || !connection?.dc || connection.dc.readyState !== 'open') {
      showToast('Нет прямого соединения с контактом', 'error');
      return;
    }

    const message = {
      id: randomString(10),
      from: 'me',
      text,
      ts: Date.now()
    };

    try {
      connection.dc.send(JSON.stringify({
        kind: 'chat',
        id: message.id,
        text: message.text,
        ts: message.ts
      }));
    } catch {
      showToast('Сообщение не отправлено', 'error');
      return;
    }

    appendMessage(contact.id, message);
    el.messageInput.value = '';
    resizeComposer();
    renderChat();
  }

  /* ------------------------------------------------------------------ */
  /* Invite codes                                                        */
  /* ------------------------------------------------------------------ */

  function formatCode(raw) {
    return `KX-${raw.slice(0, 4).toUpperCase()}-${raw.slice(4).toUpperCase()}`;
  }

  function publishInviteSnapshot() {
    if (!invite) return;
    if (!bus.isOnline()) return;

    const busy = [...connections.values()]
      .some((connection) => !connection.closed && connection.room === invite.topic);
    if (busy) return;

    invite.publishedAt = Date.now();
    bus.publish(snapshotTopic(invite.topic), {
      kind: 'invite',
      from: state.profile.id,
      name: state.profile.name,
      room: invite.topic,
      session: invite.createdAt
    }, { retain: true });
  }

  function setInviteCode() {
    if (invite) {
      clearSnapshot(invite.topic);
      unwatchRoom(invite.topic);
    }

    const raw = randomString(8, INVITE_ALPHABET);
    invite = {
      raw,
      topic: `i-${raw.toLowerCase()}`,
      display: formatCode(raw),
      createdAt: Date.now(),
      publishedAt: 0
    };

    el.inviteCode.textContent = invite.display;

    watchRoom(invite.topic);
    publishInviteSnapshot();
  }

  function normalizeInvite(value) {
    let cleaned = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.startsWith('KX')) cleaned = cleaned.slice(2);
    if (cleaned.length !== 8) return null;
    for (const char of cleaned) {
      if (!INVITE_ALPHABET.includes(char)) return null;
    }
    return cleaned.toLowerCase();
  }

  function setCodeStatus(text, type = '') {
    if (!text) {
      el.codeStatus.hidden = true;
      el.codeStatus.textContent = '';
      el.codeStatus.className = 'form-status';
      return;
    }
    el.codeStatus.hidden = false;
    el.codeStatus.textContent = text;
    el.codeStatus.className = `form-status${type ? ` is-${type}` : ''}`;
  }

  function stopJoin() {
    if (!joinState) return;

    const room = joinState.room;
    const offered = joinState.phase === 'connecting';
    joinState = null;

    clearSnapshot(room);
    unwatchRoom(room);

    if (offered) {
      for (const [peerId, connection] of connections) {
        if (connection.room !== room || connection.status === 'online') continue;
        cleanupConnection(connection);
        renderContacts();
        renderChat();
        void peerId;
      }
    }

    syncRooms();
  }

  function joinByCode(value) {
    const raw = normalizeInvite(value);
    if (!raw) {
      setCodeStatus('Код должен состоять из 8 символов, например KX-AB12-CD34.', 'error');
      return;
    }

    stopJoin();

    const room = `i-${raw}`;
    joinState = {
      room,
      phase: 'waiting',
      ownerId: null,
      ownerName: '',
      startedAt: Date.now(),
      polls: 0
    };

    watchRoom(room);
    setCodeStatus('Ожидаем друга. Не закрывайте это окно…');
  }

  async function copyInviteCode() {
    if (!invite) return;

    try {
      await navigator.clipboard.writeText(invite.display);
      showToast('Код скопирован');
      return;
    } catch {
      /* Fall through to the legacy path. */
    }

    try {
      const field = document.createElement('textarea');
      field.value = invite.display;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      document.execCommand('copy');
      field.remove();
      showToast('Код скопирован');
    } catch {
      showToast('Не удалось скопировать код', 'error');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Profile and contacts actions                                        */
  /* ------------------------------------------------------------------ */

  function openNameDialog() {
    el.nameInput.value = state.profile.name;
    el.nameDialog.showModal();
    window.setTimeout(() => {
      el.nameInput.focus();
      el.nameInput.select();
    }, 30);
  }

  function removeActiveContact() {
    const contact = activeContact();
    if (!contact) return;

    if (!window.confirm(`Удалить ${contact.name} из контактов?`)) return;

    const connection = connections.get(contact.id);
    if (connection) cleanupConnection(connection);
    if (contact.secret) clearSnapshot(`c-${contact.secret}`);

    state.contacts = state.contacts.filter((item) => item.id !== contact.id);
    delete state.messages[contact.id];
    delete state.unread[contact.id];
    state.activePeerId = null;

    saveState();
    renderContacts();
    renderChat();
    syncRooms();
  }

  function resizeComposer() {
    el.messageInput.style.height = 'auto';
    el.messageInput.style.height = `${Math.min(150, el.messageInput.scrollHeight)}px`;
  }

  /* ------------------------------------------------------------------ */
  /* Polling loop                                                        */
  /* ------------------------------------------------------------------ */

  function pollTick() {
    bus.ensureConnected();
    if (!bus.isOnline()) return;

    syncRooms();

    const negotiating = [...connections.values()]
      .some((connection) => !connection.closed && connection.status !== 'online');
    if (negotiating) bus.restartQuiet(NEGOTIATION_QUIET);

    /* Keep our retained snapshot current until the channel is actually open. */
    for (const connection of connections.values()) {
      if (connection.closed || connection.status === 'online') continue;
      publishSnapshot(connection);
    }

    if (invite && Date.now() - invite.publishedAt > INVITE_REFRESH) {
      publishInviteSnapshot();
    }

    for (const contact of state.contacts) {
      if (!contact.secret || isOnline(contact.id)) continue;
      maybeInitiateContact(contact);
    }

    if (joinState && joinState.phase === 'waiting') {
      joinState.polls += 1;
      if (joinState.polls === 7) {
        setCodeStatus('Друг ещё не подключился. Проверьте код и попросите его открыть Messenger.');
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  el.contacts.addEventListener('click', (event) => {
    const button = event.target.closest('.contact');
    if (!button) return;
    setActiveContact(button.dataset.id);
  });

  el.newCodeBtn.addEventListener('click', () => {
    setInviteCode();
    showToast('Код обновлён');
  });

  el.copyCodeBtn.addEventListener('click', () => {
    copyInviteCode();
  });

  const openAddFriend = () => {
    el.codeInput.value = '';
    setCodeStatus('');
    el.codeDialog.showModal();
    window.setTimeout(() => el.codeInput.focus(), 40);
  };

  el.enterCodeBtn.addEventListener('click', openAddFriend);
  el.addFriendBtn.addEventListener('click', openAddFriend);
  el.addFriendRail.addEventListener('click', openAddFriend);
  el.emptyAddBtn.addEventListener('click', openAddFriend);

  el.closeCodeDialog.addEventListener('click', () => {
    el.codeDialog.close();
  });
  el.cancelCodeBtn.addEventListener('click', () => {
    el.codeDialog.close();
  });
  el.codeDialog.addEventListener('close', () => {
    if (joinState) stopJoin();
  });

  el.codeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    joinByCode(el.codeInput.value);
  });

  el.profileBtn.addEventListener('click', openNameDialog);
  el.editNameBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openNameDialog();
  });

  el.closeNameDialog.addEventListener('click', () => el.nameDialog.close());
  el.cancelNameBtn.addEventListener('click', () => el.nameDialog.close());

  el.nameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = sanitizeName(el.nameInput.value, state.profile.name);
    state.profile.name = name;
    saveState();
    renderProfile();
    renderChat();

    for (const connection of connections.values()) {
      if (connection.status !== 'online' || !connection.dc) continue;
      try {
        connection.dc.send(JSON.stringify({
          kind: 'profile',
          id: state.profile.id,
          name
        }));
      } catch {
        /* Skip closed channels. */
      }
    }

    el.nameDialog.close();
  });

  el.deleteContactBtn.addEventListener('click', removeActiveContact);

  el.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });

  el.messageInput.addEventListener('input', resizeComposer);

  el.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  renderProfile();
  renderContacts();
  renderChat();

  bus.start();
  setInviteCode();
  syncRooms();

  pollTimer = setInterval(pollTick, POLL_INTERVAL);
  pollTick();

  window.addEventListener('beforeunload', () => {
    clearInterval(pollTimer);
    for (const connection of connections.values()) cleanupConnection(connection);
  });

  window.__keryxMessenger = {
    state,
    connections,
    bus,
    snapshot: () => ({
      profile: state.profile,
      invite: invite?.display || null,
      join: joinState ? { room: joinState.room, phase: joinState.phase } : null,
      contacts: state.contacts.map((contact) => ({
        id: contact.id,
        name: contact.name,
        secret: Boolean(contact.secret)
      })),
      rooms: [...watchedRooms.keys()],
      connections: [...connections.values()].map((connection) => ({
        peerId: connection.peerId,
        room: connection.room,
        status: connection.status,
        pc: connection.pc.connectionState,
        ice: connection.pc.iceConnectionState,
        dc: connection.dc?.readyState || null,
        kind: connection.localKind
      }))
    })
  };
})();
