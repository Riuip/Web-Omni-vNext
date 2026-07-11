(function() {
  "use strict";

  const LOCK_MS = 5 * 60 * 1000;
  const VAULT_PORT_NAME = "wo-vault-service";
  const BACKUP_FORMAT = "web-omni-vault";
  const BACKUP_VERSION = 3;
  const LEGACY_KDF = Object.freeze({
    version: 1,
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations: 600000,
    keyLength: 256,
  });
  const CURRENT_KDF = Object.freeze({
    version: 2,
    algorithm: "PBKDF2",
    hash: "SHA-256",
    iterations: 900000,
    keyLength: 256,
  });
  const MASTER_PASSWORD_MIN = 12;
  const MASTER_PASSWORD_MAX = 128;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
  const MAX_VAULT_ENTRIES = 5000;
  const MAX_CIPHERTEXT_BYTES = MAX_IMPORT_BYTES;
  const CLIPBOARD_CLEAR_MS = 30 * 1000;
  const ENTRY_FIELD_LIMITS = Object.freeze({
    id: 128,
    site: 2048,
    username: 512,
    password: 4096,
    note: 10000,
  });
  let dataKey = null;
  let vaultKdf = null;
  let lockTimer = null;
  let entries = [];
  let servicePort = null;
  let mainTabsBound = false;
  let clipboardCleanup = null;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeKdf(value, allowLegacy) {
    if (value == null && allowLegacy) return { ...LEGACY_KDF };
    if (!isPlainObject(value)) throw new Error("invalid-kdf");

    const normalized = {
      version: Number(value.version),
      algorithm: String(value.algorithm || value.name || ""),
      hash: String(value.hash || ""),
      iterations: Number(value.iterations),
      keyLength: Number(value.keyLength || 256),
    };
    if (
      !Number.isInteger(normalized.version) ||
      normalized.version < 1 ||
      normalized.version > CURRENT_KDF.version ||
      normalized.algorithm !== "PBKDF2" ||
      normalized.hash !== "SHA-256" ||
      !Number.isInteger(normalized.iterations) ||
      normalized.iterations < 100000 ||
      normalized.iterations > 2000000 ||
      normalized.keyLength !== 256
    ) {
      throw new Error("unsupported-kdf");
    }
    return normalized;
  }

  function validateByteArray(value, minimumLength, maximumLength, label) {
    const source = value instanceof Uint8Array ? Array.from(value) : value;
    if (
      !Array.isArray(source) ||
      source.length < minimumLength ||
      source.length > maximumLength ||
      source.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
    ) {
      throw new Error("invalid-" + label);
    }
    return new Uint8Array(source);
  }

  function validateEncryptedPayload(payload, label) {
    if (!isPlainObject(payload)) throw new Error("invalid-" + label);
    validateByteArray(payload.iv, 12, 12, label + "-iv");
    validateByteArray(payload.data, 16, MAX_CIPHERTEXT_BYTES, label + "-data");
    return payload;
  }

  async function deriveKey(password, pin, salt, kdf) {
    const parameters = normalizeKdf(kdf, false);
    let secret = String(password) + ":" + String(pin);
    const secretBytes = new TextEncoder().encode(secret);
    secret = "";
    let material;
    try {
      material = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveKey"]);
    } finally {
      secretBytes.fill(0);
    }

    return crypto.subtle.deriveKey(
      {
        name: parameters.algorithm,
        salt,
        iterations: parameters.iterations,
        hash: parameters.hash,
      },
      material,
      { name: "AES-GCM", length: parameters.keyLength },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptPayload(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    try {
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
      return { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) };
    } finally {
      plaintext.fill(0);
    }
  }

  async function decryptPayload(payload, key) {
    let ciphertext;
    let plaintext;
    try {
      validateEncryptedPayload(payload, "encrypted-payload");
      ciphertext = new Uint8Array(payload.data);
      plaintext = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(payload.iv) },
        key,
        ciphertext
      ));
      return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
      return null;
    } finally {
      if (ciphertext) ciphertext.fill(0);
      if (plaintext) plaintext.fill(0);
    }
  }

  function getPasswordCategories(password) {
    return [
      /\p{Ll}/u.test(password),
      /\p{Lu}/u.test(password),
      /\p{N}/u.test(password),
      /[^\p{L}\p{N}]/u.test(password),
    ].filter(Boolean).length;
  }

  function validateMasterPassword(password) {
    if (password.length < MASTER_PASSWORD_MIN) return "主密码至少需要 12 位。";
    if (password.length > MASTER_PASSWORD_MAX) return "主密码不能超过 128 位。";
    if (new Set(password).size < 4) return "主密码中至少需要 4 个不同字符。";
    const categories = getPasswordCategories(password);
    if (password.length < 16 && categories < 3) {
      return "12 到 15 位的主密码需要包含大写字母、小写字母、数字、符号中的至少 3 类。";
    }
    if (password.length < 20 && categories < 2) {
      return "16 到 19 位的主密码需要包含至少 2 类字符；20 位以上可使用长密码短语。";
    }
    return "";
  }

  function getStrength(password) {
    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (password.length >= 16) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;
    if (password.length < 6) score = Math.min(score, 1);

    const levels = [
      { min: 0, label: "极弱", color: "#ff5d5d", width: "15%" },
      { min: 2, label: "弱", color: "#ffb020", width: "30%" },
      { min: 3, label: "一般", color: "#e3b341", width: "50%" },
      { min: 5, label: "强", color: "#35c759", width: "75%" },
      { min: 6, label: "极强", color: "#58a6ff", width: "100%" },
    ];

    let result = levels[0];
    for (const item of levels) {
      if (score >= item.min) result = item;
    }
    return result;
  }

  function generatePassword(length, options) {
    const size = Number(length) || 16;
    const settings = options || {};
    const lower = "abcdefghijkmnopqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const symbols = "!@#$%^&*_+-=?";

    let charset = "";
    const requiredSets = [];

    if (settings.lower !== false) {
      charset += lower;
      requiredSets.push(lower);
    }
    if (settings.upper !== false) {
      charset += upper;
      requiredSets.push(upper);
    }
    if (settings.digits !== false) {
      charset += digits;
      requiredSets.push(digits);
    }
    if (settings.symbols !== false) {
      charset += symbols;
      requiredSets.push(symbols);
    }

    if (!charset) charset = lower + upper + digits;

    let password = "";
    requiredSets.forEach((set) => {
      password += set[secureRandomIndex(set.length)];
    });

    for (let index = password.length; index < size; index++) {
      password += charset[secureRandomIndex(charset.length)];
    }

    const characters = password.split("");
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = secureRandomIndex(index + 1);
      [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
    }
    return characters.join("");
  }

  function secureRandomIndex(max) {
    const size = Math.max(1, Number(max) || 1);
    const range = 0x100000000;
    const limit = Math.floor(range / size) * size;
    const buffer = new Uint32Array(1);
    do {
      crypto.getRandomValues(buffer);
    } while (buffer[0] >= limit);
    return buffer[0] % size;
  }

  function createEntryId(usedIds) {
    let id;
    do {
      if (crypto.randomUUID) {
        id = crypto.randomUUID();
      } else {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        id = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
        bytes.fill(0);
      }
    } while (usedIds && usedIds.has(id));
    return id;
  }

  function readEntryField(entry, field, required) {
    const value = entry[field];
    if (value == null && !required) return "";
    if (typeof value !== "string") throw new Error("invalid-entry-" + field);
    if (required && !value.trim()) throw new Error("invalid-entry-" + field);
    if (value.length > ENTRY_FIELD_LIMITS[field]) throw new Error("entry-" + field + "-too-long");
    return field === "site" || field === "username" || field === "note" ? value.trim() : value;
  }

  function normalizeEntries(rawEntries, existingIds) {
    if (!Array.isArray(rawEntries)) throw new Error("invalid-entries");
    if (rawEntries.length > MAX_VAULT_ENTRIES) throw new Error("too-many-entries");

    const usedIds = new Set(existingIds || []);
    let changed = false;
    const normalized = rawEntries.map((entry) => {
      if (!isPlainObject(entry)) throw new Error("invalid-entry");
      const site = readEntryField(entry, "site", true);
      const username = readEntryField(entry, "username", false);
      const password = readEntryField(entry, "password", true);
      const note = readEntryField(entry, "note", false);
      let id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (id.length > ENTRY_FIELD_LIMITS.id) throw new Error("entry-id-too-long");
      if (!id || usedIds.has(id)) {
        id = createEntryId(usedIds);
        changed = true;
      }
      usedIds.add(id);

      const created = Number.isFinite(Number(entry.created)) && Number(entry.created) > 0
        ? Number(entry.created)
        : Date.now();
      const normalizedEntry = { id, site, username, password, note, created };
      if (Number.isFinite(Number(entry.updated)) && Number(entry.updated) > 0) {
        normalizedEntry.updated = Number(entry.updated);
      }
      if (
        id !== entry.id ||
        site !== entry.site ||
        username !== (entry.username || "") ||
        password !== entry.password ||
        note !== (entry.note || "") ||
        created !== entry.created
      ) {
        changed = true;
      }
      return normalizedEntry;
    });
    return { entries: normalized, changed };
  }

  function validateBackupEnvelope(data) {
    if (!isPlainObject(data) || data.format !== BACKUP_FORMAT) throw new Error("invalid-format");
    const version = Number(data.version);
    if (version !== 2 && version !== BACKUP_VERSION) throw new Error("unsupported-backup-version");
    const kdf = version === 2 ? { ...LEGACY_KDF } : normalizeKdf(data.kdf, false);
    const salt = validateByteArray(data.salt, 16, 64, "backup-salt");
    validateEncryptedPayload(data.check, "backup-check");
    if (data.entries != null) validateEncryptedPayload(data.entries, "backup-entries");
    return { version, kdf, salt, check: data.check, entries: data.entries || null };
  }

  async function digestSensitiveText(value) {
    const bytes = new TextEncoder().encode(String(value));
    try {
      return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    } finally {
      bytes.fill(0);
    }
  }

  function digestsEqual(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
  }

  function cancelClipboardCleanup() {
    if (!clipboardCleanup) return;
    clearTimeout(clipboardCleanup.timer);
    clipboardCleanup.digest.fill(0);
    clipboardCleanup = null;
  }

  function runClipboardCleanupNow() {
    if (!clipboardCleanup) return;
    const cleanup = clipboardCleanup;
    clearTimeout(cleanup.timer);
    clipboardCleanup = null;
    clearClipboardIfMatches(cleanup.digest);
  }

  async function clearClipboardIfMatches(expectedDigest) {
    let current = "";
    let currentDigest;
    try {
      current = await navigator.clipboard.readText();
      currentDigest = await digestSensitiveText(current);
      current = "";
      if (digestsEqual(currentDigest, expectedDigest)) await navigator.clipboard.writeText("");
    } catch (error) {
      // Clipboard reads can be denied once the page loses focus; clearing remains best effort.
    } finally {
      current = "";
      if (currentDigest) currentDigest.fill(0);
      expectedDigest.fill(0);
    }
  }

  async function copySensitiveText(value) {
    await navigator.clipboard.writeText(value);
    cancelClipboardCleanup();
    const digest = await digestSensitiveText(value);
    const cleanup = { digest, timer: null };
    cleanup.timer = setTimeout(() => {
      if (clipboardCleanup === cleanup) clipboardCleanup = null;
      clearClipboardIfMatches(digest);
    }, CLIPBOARD_CLEAR_MS);
    clipboardCleanup = cleanup;
  }

  function clearInputValues() {
    document.querySelectorAll('input[type="password"], #entryPassword').forEach((input) => {
      input.value = "";
    });
  }

  async function saveEntries() {
    if (!dataKey) return;
    if (entries.length > MAX_VAULT_ENTRIES) throw new Error("too-many-entries");
    const encrypted = await encryptPayload(entries, dataKey);
    await chrome.storage.local.set({ woVaultEntries: encrypted });
  }

  function resetLockTimer() {
    clearTimeout(lockTimer);
    lockTimer = setTimeout(lockVault, LOCK_MS);
  }

  function lockVault() {
    clearTimeout(lockTimer);
    runClipboardCleanupNow();
    clearInputValues();
    document.querySelectorAll(".overlay").forEach((overlay) => overlay.remove());
    dataKey = null;
    vaultKdf = null;
    entries = [];
    showAuth();
    publishVaultState();
  }

  function connectVaultService() {
    try {
      servicePort = chrome.runtime.connect({ name: VAULT_PORT_NAME });
      servicePort.onMessage.addListener(handleVaultServiceMessage);
      servicePort.onDisconnect.addListener(() => {
        servicePort = null;
        setTimeout(connectVaultService, 500);
      });
      publishVaultState();
    } catch (error) {
      servicePort = null;
    }
  }

  function publishVaultState() {
    if (!servicePort) return;
    try {
      servicePort.postMessage({ type: "WO_VAULT_STATE", unlocked: Boolean(dataKey) });
    } catch (error) {}
  }

  async function handleVaultServiceMessage(message) {
    if (!message || message.type !== "WO_VAULT_REQUEST" || !message.requestId) return;
    let result;
    try {
      if (message.command === "GET_STATUS") {
        result = {
          ok: true,
          status: dataKey ? "unlocked" : "locked",
          data: { unlocked: Boolean(dataKey), count: dataKey ? entries.length : 0 },
        };
      } else if (!dataKey) {
        result = { ok: false, status: "locked", error: { code: "VAULT_LOCKED", message: "密码库尚未解锁。" } };
      } else if (message.command === "FIND_CREDENTIALS") {
        resetLockTimer();
        const hostname = normalizeHostname(message.payload && message.payload.hostname);
        const matches = entries
          .filter((entry) => normalizeHostname(entry.site) === hostname)
          .map((entry) => ({
            id: entry.id || null,
            site: entry.site || "",
            username: entry.username || "",
            password: entry.password || "",
            note: entry.note || "",
          }));
        result = { ok: true, status: "executed", data: { entries: matches } };
      } else if (message.command === "SAVE_CREDENTIAL") {
        resetLockTimer();
        const payload = message.payload || {};
        const site = String(payload.site || payload.hostname || "").trim();
        let password = String(payload.password || "");
        if (!site || !password) throw new Error("站点和密码不能为空。");
        const normalized = normalizeHostname(site);
        const username = String(payload.username || "").trim();
        const existing = entries.find((entry) =>
          normalizeHostname(entry.site) === normalized && String(entry.username || "") === username
        );
        try {
          const draft = {
            id: existing ? existing.id : "",
            site,
            username,
            password,
            note: String(payload.note != null ? payload.note : (existing ? existing.note : "")),
            created: existing ? existing.created : Date.now(),
            updated: existing ? Date.now() : undefined,
          };
          const validated = normalizeEntries(
            [draft],
            entries.filter((entry) => entry !== existing).map((entry) => entry.id)
          ).entries[0];
          if (existing) Object.assign(existing, validated);
          else entries.push(validated);
          await saveEntries();
          renderVault();
          result = { ok: true, status: "saved" };
        } finally {
          password = "";
          try {
            if (Object.prototype.hasOwnProperty.call(payload, "password")) payload.password = "";
          } catch (error) {}
        }
      } else {
        result = { ok: false, status: "unsupported", error: { code: "ACTION_FAILED", message: "未知密码库请求。" } };
      }
    } catch (error) {
      result = { ok: false, status: "failed", error: { code: "ACTION_FAILED", message: error.message || String(error) } };
    }

    try {
      servicePort?.postMessage({ type: "WO_VAULT_RESPONSE", requestId: message.requestId, result });
    } catch (error) {}
  }

  function normalizeHostname(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw).hostname.toLowerCase();
    } catch (error) {
      return raw.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    }
  }

  function needsKdfUpgrade(kdf) {
    return kdf.version < CURRENT_KDF.version || kdf.iterations < CURRENT_KDF.iterations;
  }

  async function migrateVaultKdf(password, pin, currentEntries) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const upgradedKey = await deriveKey(password, pin, salt, CURRENT_KDF);
    const check = await encryptPayload({ check: "OK", time: Date.now() }, upgradedKey);
    const encryptedEntries = await encryptPayload(currentEntries, upgradedKey);
    await chrome.storage.local.set({
      woVaultSalt: Array.from(salt),
      woVaultKdf: { ...CURRENT_KDF },
      woVaultCheck: check,
      woVaultEntries: encryptedEntries,
    });
    return upgradedKey;
  }

  async function init() {
    try {
      const state = await chrome.storage.local.get(["woVaultSalt", "woVaultKdf", "woVaultCheck"]);
      if (!state.woVaultSalt) {
        showSetup();
      } else {
        showUnlock(state);
      }
    } catch (error) {
      console.error("Vault init error:", error);
      $("authScreen").innerHTML = '<div class="auth-box"><div class="auth-icon">!</div><h2 class="auth-title">加载失败</h2><p class="auth-desc">请确认你是从扩展页面打开密码库。</p></div>';
    }
  }

  function showAuth() {
    $("authScreen").style.display = "flex";
    $("mainScreen").style.display = "none";
    $("headerBtns").style.display = "none";
    init();
  }

  function showSetup() {
    $("authScreen").innerHTML = [
      '<div class="auth-box">',
      '  <div class="auth-icon">WO</div>',
      '  <h2 class="auth-title">创建密码库</h2>',
      '  <p class="auth-desc">设置主密码和安全码，用来保护你的本地凭据。</p>',
      '  <div class="form-group"><label class="label">主密码（至少 12 位）</label><input id="setupPassword" type="password" class="input" placeholder="设置强密码" minlength="12" maxlength="128" autocomplete="new-password"><div class="strength-bar"><div id="setupStrengthBar" class="strength-fill" style="width:0;"></div></div><div id="setupStrengthText" style="font-size:12px;margin-top:6px;color:var(--wo-text-muted);">12-15 位需 3 类字符，16-19 位需 2 类，20 位以上可使用密码短语。</div></div>',
      '  <div class="form-group"><label class="label">确认主密码</label><input id="setupPasswordConfirm" type="password" class="input" placeholder="再输入一次" maxlength="128" autocomplete="new-password"></div>',
      '  <div class="form-group"><label class="label">安全码（4-8 位数字）</label><input id="setupPin" type="password" class="input" placeholder="数字安全码" inputmode="numeric" maxlength="8" autocomplete="new-password"></div>',
      '  <button id="setupSubmit" class="btn btn-primary btn-block">创建密码库</button>',
      '</div>',
    ].join("");

    $("setupPassword").addEventListener("input", (event) => {
      const strength = getStrength(event.target.value);
      $("setupStrengthBar").style.width = strength.width;
      $("setupStrengthBar").style.background = strength.color;
      $("setupStrengthText").textContent = event.target.value
        ? ("强度：" + strength.label)
        : "12-15 位需 3 类字符，16-19 位需 2 类，20 位以上可使用密码短语。";
      $("setupStrengthText").style.color = event.target.value ? strength.color : "var(--wo-text-muted)";
    });

    $("setupSubmit").addEventListener("click", async () => {
      let password = $("setupPassword").value;
      let passwordConfirm = $("setupPasswordConfirm").value;
      let pin = $("setupPin").value;

      const passwordError = validateMasterPassword(password);
      if (passwordError) {
        alert(passwordError);
        return;
      }
      if (password !== passwordConfirm) {
        alert("两次输入的主密码不一致。");
        $("setupPasswordConfirm").value = "";
        return;
      }
      if (!/^\d{4,8}$/.test(pin)) {
        alert("安全码需要 4 到 8 位数字。");
        $("setupPin").value = "";
        return;
      }

      const submit = $("setupSubmit");
      submit.disabled = true;
      clearInputValues();
      try {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        dataKey = await deriveKey(password, pin, salt, CURRENT_KDF);
        const check = await encryptPayload({ check: "OK", time: Date.now() }, dataKey);
        const encryptedEntries = await encryptPayload([], dataKey);
        await chrome.storage.local.set({
          woVaultSalt: Array.from(salt),
          woVaultKdf: { ...CURRENT_KDF },
          woVaultCheck: check,
          woVaultEntries: encryptedEntries,
        });

        vaultKdf = { ...CURRENT_KDF };
        entries = [];
        resetLockTimer();
        showMain();
        publishVaultState();
      } catch (error) {
        dataKey = null;
        vaultKdf = null;
        alert("创建密码库失败，请稍后重试。");
      } finally {
        password = "";
        passwordConfirm = "";
        pin = "";
        submit.disabled = false;
      }
    });
  }

  function showUnlock(state) {
    $("authScreen").innerHTML = [
      '<div class="auth-box">',
      '  <div class="auth-icon">WO</div>',
      '  <h2 class="auth-title">解锁密码库</h2>',
      '  <p class="auth-desc">输入主密码和安全码。</p>',
      '  <div class="form-group"><input id="unlockPassword" type="password" class="input" placeholder="主密码" maxlength="128" autocomplete="current-password"></div>',
      '  <div class="form-group"><input id="unlockPin" type="password" class="input" placeholder="安全码" inputmode="numeric" maxlength="8" autocomplete="current-password"></div>',
      '  <button id="unlockSubmit" class="btn btn-primary btn-block">解锁</button>',
      '  <button id="unlockReset" class="btn btn-block" style="margin-top:8px;">忘记密码？重置</button>',
      '</div>',
    ].join("");

    async function tryUnlock() {
      let password = $("unlockPassword").value;
      let pin = $("unlockPin").value;
      if (!password || !pin) return;
      const submit = $("unlockSubmit");
      if (submit.disabled) return;
      submit.disabled = true;
      clearInputValues();

      let candidateKey = null;
      try {
        const kdf = normalizeKdf(state.woVaultKdf, true);
        const salt = validateByteArray(state.woVaultSalt, 16, 64, "vault-salt");
        validateEncryptedPayload(state.woVaultCheck, "vault-check");
        candidateKey = await deriveKey(password, pin, salt, kdf);
        const check = await decryptPayload(state.woVaultCheck, candidateKey);
        if (!check || check.check !== "OK") throw new Error("vault-auth-failed");

        const storage = await chrome.storage.local.get(["woVaultEntries"]);
        let decryptedEntries = [];
        if (storage.woVaultEntries != null) {
          decryptedEntries = await decryptPayload(storage.woVaultEntries, candidateKey);
          if (!Array.isArray(decryptedEntries)) throw new Error("vault-data-corrupt");
        }
        const normalized = normalizeEntries(decryptedEntries);
        entries = normalized.entries;
        dataKey = candidateKey;
        vaultKdf = kdf;
        candidateKey = null;

        let migrationFailed = false;
        if (needsKdfUpgrade(kdf)) {
          try {
            dataKey = await migrateVaultKdf(password, pin, entries);
            vaultKdf = { ...CURRENT_KDF };
          } catch (error) {
            migrationFailed = true;
          }
        } else if (normalized.changed) {
          await saveEntries();
        }

        resetLockTimer();
        showMain();
        publishVaultState();
        if (migrationFailed) {
          alert("密码库已解锁，但安全参数升级失败；下次解锁时会再次尝试。");
        }
      } catch (error) {
        dataKey = null;
        vaultKdf = null;
        entries = [];
        if (error.message === "vault-data-corrupt") {
          alert("密码库数据无法解密或已损坏。请保留现有数据并从可信备份恢复。");
        } else if (error.message === "unsupported-kdf" || error.message.startsWith("invalid-vault")) {
          alert("密码库的安全参数无效或暂不受支持。");
        } else {
          alert("主密码或安全码错误。");
        }
      } finally {
        candidateKey = null;
        password = "";
        pin = "";
        submit.disabled = false;
      }
    }

    $("unlockSubmit").addEventListener("click", tryUnlock);
    $("unlockPassword").addEventListener("keydown", (event) => {
      if (event.key === "Enter") $("unlockPin").focus();
    });
    $("unlockPin").addEventListener("keydown", (event) => {
      if (event.key === "Enter") tryUnlock();
    });
    $("unlockReset").addEventListener("click", () => {
      if (!confirm("重置会删除所有已保存的密码，确定继续吗？")) return;
      clearInputValues();
      chrome.storage.local.remove(["woVaultSalt", "woVaultKdf", "woVaultCheck", "woVaultEntries"], () => init());
    });

    setTimeout(() => $("unlockPassword").focus(), 120);
  }

  function showMain() {
    $("authScreen").style.display = "none";
    $("mainScreen").style.display = "block";
    $("headerBtns").style.display = "flex";
    $("headerBtns").innerHTML = [
      '<button class="btn btn-sm" id="headerExport">导出</button>',
      '<button class="btn btn-sm" id="headerImport">导入</button>',
      '<button class="btn btn-sm" id="headerLock">锁定</button>',
    ].join("");

    $("headerExport").onclick = async () => {
      const stored = await chrome.storage.local.get(["woVaultSalt", "woVaultKdf", "woVaultCheck", "woVaultEntries"]);
      const exportKdf = normalizeKdf(stored.woVaultKdf || vaultKdf, true);
      const backup = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        kdf: exportKdf,
        salt: stored.woVaultSalt,
        check: stored.woVaultCheck,
        entries: stored.woVaultEntries,
      };
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "web-omni-vault-encrypted-" + new Date().toISOString().slice(0, 10) + ".json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    };

    $("headerImport").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async (event) => {
        let rawText = "";
        let importedEntries = [];
        let backupKey = null;
        let backupPassword = "";
        let backupPin = "";
        try {
          const file = event.target.files && event.target.files[0];
          if (!file) return;
          if (file.size > MAX_IMPORT_BYTES) throw new Error("file-too-large");
          rawText = await file.text();
          const data = JSON.parse(rawText);
          rawText = "";
          if (Array.isArray(data)) {
            if (!confirm("这是旧版明文备份。继续导入后，记录会使用当前密码库密钥重新加密。")) return;
            importedEntries = data;
          } else {
            const backup = validateBackupEnvelope(data);
            backupKey = dataKey;
            let check = await decryptPayload(backup.check, backupKey);
            if (!check || check.check !== "OK") {
              backupPassword = prompt("输入该备份的主密码：");
              if (backupPassword === null) return;
              backupPin = prompt("输入该备份的安全码：");
              if (backupPin === null) return;
              backupKey = await deriveKey(backupPassword, backupPin, backup.salt, backup.kdf);
              check = await decryptPayload(backup.check, backupKey);
              if (!check || check.check !== "OK") throw new Error("backup-auth-failed");
            }
            importedEntries = backup.entries ? await decryptPayload(backup.entries, backupKey) : [];
          }
          if (!Array.isArray(importedEntries)) throw new Error("invalid-entries");
          if (entries.length + importedEntries.length > MAX_VAULT_ENTRIES) throw new Error("too-many-entries");
          const normalized = normalizeEntries(importedEntries, entries.map((entry) => entry.id)).entries;
          entries = [...entries, ...normalized];
          await saveEntries();
          renderVault();
          alert("已导入 " + normalized.length + " 条记录。");
        } catch (error) {
          if (error.message === "file-too-large") {
            alert("导入失败：备份文件不能超过 5 MB。");
          } else if (error.message === "too-many-entries") {
            alert("导入失败：密码库最多保存 5000 条记录。");
          } else if (error.message === "backup-auth-failed") {
            alert("导入失败：备份主密码或安全码错误。");
          } else {
            alert("导入失败：文件结构、字段长度或加密数据无效。");
          }
        } finally {
          rawText = "";
          importedEntries = [];
          backupKey = null;
          backupPassword = "";
          backupPin = "";
          input.value = "";
        }
      };
      input.click();
    };

    $("headerLock").onclick = () => {
      lockVault();
    };

    if (!mainTabsBound) {
      mainTabsBound = true;
      $("mainTabs").addEventListener("click", (event) => {
        const tab = event.target.closest(".tab");
        if (!tab) return;
        resetLockTimer();
        document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
        tab.classList.add("active");
        $("vaultTab").style.display = tab.dataset.tab === "vault" ? "block" : "none";
        $("generatorTab").style.display = tab.dataset.tab === "generator" ? "block" : "none";
      });
    }

    renderVault();
    renderGenerator();
    checkHash();
  }

  function renderVault(filter) {
    const keyword = String(filter || "").trim();
    $("countBadge").textContent = entries.length;

    const filteredEntries = entries.filter((entry) => {
      if (!keyword) return true;
      return (entry.site + " " + entry.username + " " + entry.note).toLowerCase().includes(keyword.toLowerCase());
    });

    let html = [
      '<div class="vault-header">',
      '  <div class="search-box"><input id="vaultSearch" class="input" placeholder="搜索站点、用户名或备注" value="' + escapeHtml(keyword) + '"></div>',
      '  <button class="btn btn-primary" id="vaultAdd">新增</button>',
      '</div>',
    ].join("");

    if (!filteredEntries.length) {
      html += '<div class="empty"><span>—</span><p>' + (entries.length ? "没有匹配结果" : "还没有保存任何凭据") + '</p></div>';
    } else {
      filteredEntries.forEach((entry) => {
        const hostname = entry.site ? entry.site.replace(/^https?:\/\//, "").split("/")[0] : "未命名";
        html += [
          '<div class="entry">',
          '  <div class="entry-icon">' + escapeHtml((hostname[0] || "W").toUpperCase()) + '</div>',
          '  <div class="entry-info">',
          '    <div class="entry-site">' + escapeHtml(hostname) + '</div>',
          '    <div class="entry-user">' + escapeHtml(entry.username || "无用户名") + '</div>',
          '  </div>',
          '  <div class="entry-actions">',
          '    <button class="btn btn-sm" data-copy-id="' + escapeHtml(entry.id) + '">复制</button>',
          '    <button class="btn btn-sm" data-delete data-delete-id="' + escapeHtml(entry.id) + '">删除</button>',
          '  </div>',
          '</div>',
        ].join("");
      });
    }

    $("vaultTab").innerHTML = html;

    $("vaultSearch").addEventListener("input", (event) => renderVault(event.target.value));
    $("vaultAdd").addEventListener("click", showAddDialog);

    document.querySelectorAll("[data-copy-id]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const entry = entries.find((item) => item.id === button.dataset.copyId);
        if (!entry) return;
        let password = entry.password;
        try {
          await copySensitiveText(password);
          button.textContent = "已复制";
          setTimeout(() => {
            button.textContent = "复制";
          }, 1200);
        } catch (error) {
          alert("复制失败，请确认已允许剪贴板访问。");
        } finally {
          password = "";
        }
      });
    });

    document.querySelectorAll("[data-delete-id]").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm("确定删除这条凭据吗？")) return;
        const deleteIndex = entries.findIndex((entry) => entry.id === button.dataset.deleteId);
        if (deleteIndex < 0) return;
        entries.splice(deleteIndex, 1);
        await saveEntries();
        renderVault(keyword);
      });
    });
  }

  function showAddDialog() {
    const overlay = document.createElement("div");
    overlay.className = "overlay";

    let generated = generatePassword(16);
    const strength = getStrength(generated);
    overlay.innerHTML = [
      '<div class="dialog">',
      '  <h3>添加凭据</h3>',
      '  <div class="form-group"><label class="label">站点</label><input id="entrySite" class="input" placeholder="example.com" maxlength="2048"></div>',
      '  <div class="form-group"><label class="label">用户名 / 邮箱</label><input id="entryUser" class="input" placeholder="user@example.com" maxlength="512" autocomplete="username"></div>',
      '  <div class="form-group"><label class="label">密码</label><div style="display:flex;gap:8px;"><input id="entryPassword" type="password" class="input" maxlength="4096" autocomplete="new-password" style="flex:1;"><button class="btn" id="entryGenerate">随机</button></div><div class="strength-bar"><div id="entryStrengthBar" class="strength-fill" style="width:' + strength.width + ';background:' + strength.color + ';"></div></div><div id="entryStrengthText" style="font-size:12px;margin-top:6px;color:' + strength.color + ';">' + strength.label + '</div></div>',
      '  <div class="form-group"><label class="label">备注</label><input id="entryNote" class="input" placeholder="可选" maxlength="10000"></div>',
      '  <div style="display:flex;gap:8px;margin-top:12px;"><button class="btn btn-primary" id="entrySave" style="flex:1;">保存</button><button class="btn" id="entryCancel">取消</button></div>',
      '</div>',
    ].join("");

    document.body.appendChild(overlay);
    $("entryPassword").value = generated;
    generated = "";

    function closeDialog() {
      ["entrySite", "entryUser", "entryPassword", "entryNote"].forEach((id) => {
        if ($(id)) $(id).value = "";
      });
      overlay.remove();
    }

    $("entryPassword").addEventListener("input", (event) => {
      const nextStrength = getStrength(event.target.value);
      $("entryStrengthBar").style.width = nextStrength.width;
      $("entryStrengthBar").style.background = nextStrength.color;
      $("entryStrengthText").textContent = nextStrength.label;
      $("entryStrengthText").style.color = nextStrength.color;
    });

    $("entryGenerate").addEventListener("click", () => {
      $("entryPassword").value = generatePassword(16);
      $("entryPassword").dispatchEvent(new Event("input"));
    });

    $("entrySave").addEventListener("click", async () => {
      const site = $("entrySite").value.trim();
      const username = $("entryUser").value.trim();
      let password = $("entryPassword").value;
      const note = $("entryNote").value.trim();

      if (!site || !password) {
        alert("站点和密码不能为空。");
        return;
      }
      if (entries.length >= MAX_VAULT_ENTRIES) {
        alert("密码库最多保存 5000 条记录。");
        return;
      }

      try {
        const normalized = normalizeEntries(
          [{ id: "", site, username, password, note, created: Date.now() }],
          entries.map((entry) => entry.id)
        ).entries[0];
        entries.push(normalized);
        await saveEntries();
        closeDialog();
        renderVault();
      } catch (error) {
        alert("保存失败：字段内容过长或格式无效。");
      } finally {
        password = "";
        if ($("entryPassword")) $("entryPassword").value = "";
      }
    });

    $("entryCancel").addEventListener("click", closeDialog);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeDialog();
    });
  }

  function renderGenerator() {
    const password = generatePassword(16);
    const strength = getStrength(password);

    $("generatorTab").innerHTML = [
      '<div class="panel">',
      '  <div class="gen-result" id="generatorResult">' + password + '</div>',
      '  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">',
      '    <div style="flex:1;"><div class="strength-bar"><div id="generatorStrengthBar" class="strength-fill" style="width:' + strength.width + ';background:' + strength.color + ';"></div></div></div>',
      '    <span id="generatorStrengthText" style="font-size:12px;color:' + strength.color + ';">' + strength.label + '</span>',
      '  </div>',
      '  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">',
      '    <label class="label" style="margin:0;width:42px;">长度</label>',
      '    <input id="generatorLength" type="range" min="6" max="64" value="16" style="flex:1;accent-color:var(--wo-text);">',
      '    <span id="generatorLengthValue" style="font-size:13px;">16</span>',
      '  </div>',
      '  <div class="options">',
      '    <label><input type="checkbox" id="generatorLower" checked>小写</label>',
      '    <label><input type="checkbox" id="generatorUpper" checked>大写</label>',
      '    <label><input type="checkbox" id="generatorDigits" checked>数字</label>',
      '    <label><input type="checkbox" id="generatorSymbols" checked>符号</label>',
      '  </div>',
      '  <div style="display:flex;gap:8px;">',
      '    <button class="btn btn-primary" id="generatorRefresh" style="flex:1;">重新生成</button>',
      '    <button class="btn" id="generatorCopy" style="flex:1;">复制</button>',
      '  </div>',
      '</div>',
    ].join("");

    function regenerate() {
      const nextPassword = generatePassword($("generatorLength").value, {
        lower: $("generatorLower").checked,
        upper: $("generatorUpper").checked,
        digits: $("generatorDigits").checked,
        symbols: $("generatorSymbols").checked,
      });
      const nextStrength = getStrength(nextPassword);
      $("generatorResult").textContent = nextPassword;
      $("generatorStrengthBar").style.width = nextStrength.width;
      $("generatorStrengthBar").style.background = nextStrength.color;
      $("generatorStrengthText").textContent = nextStrength.label;
      $("generatorStrengthText").style.color = nextStrength.color;
    }

    $("generatorLength").addEventListener("input", (event) => {
      $("generatorLengthValue").textContent = event.target.value;
      regenerate();
    });

    ["generatorLower", "generatorUpper", "generatorDigits", "generatorSymbols"].forEach((id) => {
      $(id).addEventListener("change", regenerate);
    });

    $("generatorRefresh").addEventListener("click", regenerate);
    $("generatorCopy").addEventListener("click", async () => {
      let password = $("generatorResult").textContent;
      try {
        await copySensitiveText(password);
        $("generatorCopy").textContent = "已复制";
        setTimeout(() => {
          $("generatorCopy").textContent = "复制";
        }, 1200);
      } catch (error) {
        alert("复制失败，请确认已允许剪贴板访问。");
      } finally {
        password = "";
      }
    });
  }

  function checkHash() {
    const hash = location.hash.replace("#", "");
    if (hash === "generator" && $("mainScreen").style.display !== "none") {
      document.querySelectorAll(".tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === "generator");
      });
      $("vaultTab").style.display = "none";
      $("generatorTab").style.display = "block";
    }
  }

  window.addEventListener("hashchange", checkHash);
  ["pointerdown", "keydown", "input"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      if (dataKey) resetLockTimer();
    }, { passive: true });
  });
  window.addEventListener("pagehide", () => {
    runClipboardCleanupNow();
    clearInputValues();
    dataKey = null;
    vaultKdf = null;
    entries = [];
    publishVaultState();
  });
  connectVaultService();
  init();
})();
