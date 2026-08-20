// Client half of the peak-valley-alarm plugin — hand-built bundle in the
// platform's lazy-CJS format (window.__ModuleLoader__.load({ id, factory })).
// Watches the Beijing-time 峰谷 schedule (peak windows configurable, same
// defaults as peak-valley-ticker) and, on every period flip, shows a 国风
// toast banner, plays a WebAudio chime, and fires a browser notification.
// The toast shows the DeepSeek API remaining balance (fetched through the
// host proxy /peak-valley-alarm/balance, so the API key never reaches the
// browser) and the current input/output token prices.

window.__ModuleLoader__.load({
  id: "peak-valley-alarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    // ---------------------------------------------------------------- rules
    // All times are Beijing wall-clock (UTC+8), computed from UTC components
    // of the shifted Date so DST and local-timezone skew can never interfere.
    const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
    // Peak windows as [startHour, endHour] (Beijing time); the rest is 谷.
    const DEFAULT_WINDOWS = [[9, 12], [14, 18]];

    function resolveWindows(config) {
      const c = config && typeof config === "object" ? config : {};
      const raw =
        Array.isArray(c.peakWindows) && c.peakWindows.length > 0
          ? c.peakWindows
          : DEFAULT_WINDOWS;
      const windows = [];
      for (const w of raw) {
        if (!Array.isArray(w)) continue;
        const s = Number(w[0]);
        const e = Number(w[1]);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (s < 0 || e > 24 || s >= e) continue; // crossing-midnight windows unsupported
        windows.push([s * 60, e * 60]);
      }
      if (windows.length === 0) {
        return DEFAULT_WINDOWS.map(([s, e]) => [s * 60, e * 60]);
      }
      windows.sort((a, b) => a[0] - b[0]);
      return windows;
    }

    // Current state: { kind: "peak" | "valley", endMin, mins } where mins is
    // the fractional Beijing minute-of-day and endMin the period end in
    // minutes (may exceed 1440 when a valley runs past midnight).
    function stateAt(windows, nowMs) {
      const d = new Date(nowMs + BEIJING_OFFSET_MS);
      const mins =
        d.getUTCHours() * 60 +
        d.getUTCMinutes() +
        d.getUTCSeconds() / 60 +
        d.getUTCMilliseconds() / 60000;
      for (const [s, e] of windows) {
        if (mins >= s && mins < e) return { kind: "peak", endMin: e, mins };
      }
      let next = null;
      for (const [s] of windows) {
        if (mins < s) {
          next = s;
          break;
        }
      }
      return { kind: "valley", endMin: next !== null ? next : windows[0][0] + 24 * 60, mins };
    }

    // ---------------------------------------------------------------- prices
    // Official DeepSeek per-1M-token prices (valley period, USD), adjustable
    // through config.prices. Peak price = valley price × peakMultiplier; the
    // client picks the current price from the live 峰/谷 state.
    const DEFAULT_PRICES = {
      inputCacheMiss: 0.22, // 输入（未命中缓存）
      inputCacheHit: 0.007, // 输入（命中缓存）
      output: 0.66, // 输出
      peakMultiplier: 2, // 峰时 = 谷时 × 2
      currency: "$",
    };

    function resolvePrices(config) {
      const p =
        config && typeof config.prices === "object" && config.prices !== null ? config.prices : {};
      const out = {};
      for (const k of ["inputCacheMiss", "inputCacheHit", "output", "peakMultiplier"]) {
        const v = Number(p[k]);
        out[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_PRICES[k];
      }
      out.currency =
        typeof p.currency === "string" && p.currency.length > 0 ? p.currency : DEFAULT_PRICES.currency;
      return out;
    }

    function fmtPrice(v, currency) {
      const s = v >= 1 ? String(Number(v.toFixed(2))) : String(Number(v.toFixed(3)));
      return currency + s;
    }

    // Current per-1M-token input/output prices for the live 峰/谷 state.
    function currentPrices(prices, kind) {
      const k = kind === "peak" ? prices.peakMultiplier : 1;
      return { input: prices.inputCacheMiss * k, output: prices.output * k };
    }

    function priceLine(prices, kind) {
      const cp = currentPrices(prices, kind);
      return (
        "输入 " + fmtPrice(cp.input, prices.currency) +
        " · 输出 " + fmtPrice(cp.output, prices.currency) +
        " / 百万 token"
      );
    }

    // ---------------------------------------------------------------- balance
    // Balance comes from the host proxy (same origin) so the API key stays
    // server-side. Refreshed on mount, then every balanceRefreshMinutes.
    const BALANCE_URL = "/peak-valley-alarm/balance";

    async function fetchBalanceJson() {
      try {
        const res = await fetch(BALANCE_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) return { ok: false, error: "http-" + res.status };
        const data = await res.json();
        if (data && data.ok === true) return data;
        return { ok: false, error: data && typeof data.error === "string" ? data.error : "unknown" };
      } catch (err) {
        return { ok: false, error: "network" };
      }
    }

    // ---------------------------------------------------------------- audio
    // WebAudio-generated chimes — no asset files needed. The AudioContext is
    // unlocked by the first pointer interaction (browser autoplay policy);
    // a chime that fires while the context is still suspended is stashed and
    // replayed on the first unlock (30s window), so the reminder is never
    // silently lost.
    let audioCtx = null;
    let pendingChime = null; // { kind, ts } waiting for audio unlock

    function ensureAudio() {
      try {
        if (audioCtx === null) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (Ctor) audioCtx = new Ctor();
        }
        if (audioCtx !== null && audioCtx.state === "suspended") {
          audioCtx.resume().then(() => flushPendingChime()).catch(() => {});
        }
      } catch (err) {}
    }

    // 谷: pleasant two-note chime (磬). 峰: short three-note alert (锣).
    function scheduleNotes(kind) {
      const notes = kind === "valley" ? [523.25, 783.99] : [659.25, 523.25, 392];
      const t0 = audioCtx.currentTime + 0.02;
      for (let i = 0; i < notes.length; i++) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = notes[i];
        const start = t0 + i * 0.22;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(start);
        osc.stop(start + 1.2);
      }
    }

    function playChime(kind) {
      try {
        ensureAudio();
        if (audioCtx === null) return;
        if (audioCtx.state !== "running") {
          pendingChime = { kind, ts: Date.now() };
          return;
        }
        scheduleNotes(kind);
      } catch (err) {}
    }

    function flushPendingChime() {
      if (audioCtx === null || audioCtx.state !== "running" || pendingChime === null) return;
      if (Date.now() - pendingChime.ts > 30000) {
        pendingChime = null;
        return;
      }
      const kind = pendingChime.kind;
      pendingChime = null;
      scheduleNotes(kind);
    }

    function unlockAudio() {
      ensureAudio();
      flushPendingChime();
    }

    // ---------------------------------------------------------- notification
    function notifyKind(kind, st, line) {
      try {
        if (typeof window.Notification === "undefined") return;
        const title = kind === "valley" ? "低谷时段开始" : "高峰时段开始";
        const body = line;
        const show = () => new Notification(title, { body });
        if (Notification.permission === "granted") {
          show();
        } else if (Notification.permission === "default") {
          Notification.requestPermission().then((p) => {
            if (p === "granted") show();
          });
        }
      } catch (err) {}
    }

    // ------------------------------------------------------------------ css
    const STYLE_ID = "peak-valley-alarm/styles";
    const css = [
      ".pva-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:12px;padding:10px 16px 10px 12px;border-radius:14px;background:linear-gradient(150deg,rgba(250,247,239,.97),rgba(242,235,220,.94));border:1px solid rgba(176,142,78,.6);box-shadow:0 10px 30px rgba(80,55,10,.22),inset 0 1px 0 rgba(255,255,255,.7);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);font-family:'Noto Serif SC','Source Han Serif SC','Songti SC','STSong','SimSun',serif;color:#3b3324;user-select:none;cursor:pointer;pointer-events:auto;animation:pva-drop .5s cubic-bezier(.2,.9,.3,1.2)}",
      "body[data-ds-dark-theme] .pva-toast{background:linear-gradient(150deg,rgba(31,35,41,.95),rgba(21,24,29,.95));border-color:rgba(196,168,106,.5);color:#eae3d3;box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.06)}",
      "@keyframes pva-drop{from{opacity:0;transform:translate(-50%,-14px) scale(.97)}to{opacity:1;transform:translate(-50%,0)}}",
      "@media (prefers-reduced-motion:reduce){.pva-toast{animation:none}}",
      ".pva-goldline{position:absolute;top:0;left:14%;right:14%;height:1.5px;background:linear-gradient(90deg,transparent,rgba(196,168,106,.85),transparent);border-radius:2px}",
      ".pva-toast::before,.pva-toast::after{content:'';position:absolute;width:12px;height:12px;border:0 solid rgba(176,142,78,.95);pointer-events:none}",
      ".pva-toast::before{top:6px;left:6px;border-top-width:1.5px;border-left-width:1.5px;border-top-left-radius:4px}",
      ".pva-toast::after{bottom:6px;right:6px;border-bottom-width:1.5px;border-right-width:1.5px;border-bottom-right-radius:4px}",
      ".pva-toast[data-state='valley']{border-color:rgba(47,150,108,.6)}",
      ".pva-toast[data-state='peak']{border-color:rgba(190,74,50,.62)}",
      ".pva-seal{position:relative;width:42px;height:42px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Kaiti SC','STKaiti','KaiTi','Noto Serif SC',serif;font-size:24px;font-weight:700;line-height:1}",
      ".pva-seal::before,.pva-seal::after{content:'';position:absolute;border-radius:50%;pointer-events:none}",
      ".pva-seal::before{inset:-3px;border:1px solid currentColor;opacity:.9}",
      ".pva-seal::after{inset:3px;border:1px solid currentColor;opacity:.45}",
      ".pva-toast[data-state='valley'] .pva-seal{color:#1f7a58;background:radial-gradient(circle at 35% 28%,rgba(31,122,88,.32),rgba(31,122,88,.10) 62%,rgba(31,122,88,0) 74%);text-shadow:0 0 14px rgba(31,122,88,.4)}",
      ".pva-toast[data-state='peak'] .pva-seal{color:#b03a2b;background:radial-gradient(circle at 35% 28%,rgba(176,58,43,.34),rgba(176,58,43,.10) 62%,rgba(176,58,43,0) 74%);text-shadow:0 0 14px rgba(176,58,43,.4)}",
      ".pva-body{display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".pva-title{font-size:15px;font-weight:700;letter-spacing:.18em}",
      ".pva-sub{font-size:11.5px;opacity:.8;letter-spacing:.05em}",
      ".pva-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:2px}",
      ".pva-hint{font-size:10px;opacity:.5;letter-spacing:.1em}",
      ".pva-perm{font-size:10.5px;border:1px solid currentColor;border-radius:999px;padding:2px 10px;background:transparent;color:inherit;font-family:inherit;letter-spacing:.12em;cursor:pointer;opacity:.85}",
      ".pva-perm:hover{opacity:1}",
      ".pva-toast[data-state='valley'] .pva-perm{color:#1f8a63;border-color:rgba(31,138,99,.55)}",
      ".pva-toast[data-state='peak'] .pva-perm{color:#c0392b;border-color:rgba(192,57,43,.5)}",
      ".pva-balance{display:flex;align-items:baseline;gap:6px;font-size:11.5px;opacity:.85;letter-spacing:.08em;margin-top:1px}",
      ".pva-balance .pva-balance-label{opacity:.6;font-size:10px;letter-spacing:.14em}"
    ].join("\n");

    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + STYLE_ID + "\"]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "peak-valley-alarm";
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- toast
    const h = React.createElement;

    function AlarmToast(props) {
      const windows = props.windows;
      const prices = props.prices;
      const sound = props.sound !== false;
      const notify = props.notify !== false;
      const showBalance = props.showBalance;
      const refreshMinutes = props.refreshMinutes;
      const toastSeconds = typeof props.toastSeconds === "number" && props.toastSeconds > 0 ? props.toastSeconds : 8;
      const demo = props.demo === true;

      const [now, setNow] = React.useState(() => Date.now());
      const [toast, setToast] = React.useState(null);
      const [perm, setPerm] = React.useState(() =>
        typeof window.Notification === "undefined" ? "unsupported" : window.Notification.permission
      );
      const [balance, setBalance] = React.useState(null); // string | null
      const [balanceCurrency, setBalanceCurrency] = React.useState("");
      const [balanceError, setBalanceError] = React.useState(null); // string | null
      const lastKindRef = React.useRef(null);
      const demoFiredRef = React.useRef(false);
      const busyRef = React.useRef(false);
      const mountedRef = React.useRef(true);

      React.useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
      }, []);

      // Unlock WebAudio on the first interaction (autoplay policy) and
      // replay a chime that was blocked while the context was suspended.
      React.useEffect(() => {
        window.addEventListener("pointerdown", unlockAudio);
        return () => window.removeEventListener("pointerdown", unlockAudio);
      }, []);

      const refreshBalance = React.useCallback(async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        const res = await fetchBalanceJson();
        busyRef.current = false;
        if (!mountedRef.current) return;
        if (res.ok) {
          const info = res.balanceInfos && res.balanceInfos.length > 0 ? res.balanceInfos[0] : null;
          setBalance(info !== null ? String(info.totalBalance) : null);
          setBalanceCurrency(info !== null && typeof info.currency === "string" ? info.currency : "");
          setBalanceError(null);
        } else {
          setBalanceError(res.error || "unknown");
        }
      }, []);

      // Fetch on mount, then every balanceRefreshMinutes.
      React.useEffect(() => {
        mountedRef.current = true;
        refreshBalance();
        if (!(refreshMinutes > 0)) return;
        const t = setInterval(refreshBalance, refreshMinutes * 60 * 1000);
        return () => {
          mountedRef.current = false;
          clearInterval(t);
        };
      }, [refreshBalance, refreshMinutes]);

      const balanceText = React.useCallback(() => {
        if (balance !== null) return balanceCurrency + balance;
        return balanceError === "no-api-key" ? "未配置" : "--";
      }, [balance, balanceCurrency, balanceError]);

      const fire = React.useCallback(
        (kind, st) => {
          setToast({ kind, id: Date.now() });
          if (sound) playChime(kind);
          if (notify) {
            const line = priceLine(prices, kind) + (showBalance ? " · 余额 " + balanceText() : "");
            notifyKind(kind, st, line);
          }
          if (showBalance) refreshBalance();
        },
        [sound, notify, prices, showBalance, balanceText, refreshBalance]
      );

      // Fires exactly on a real period flip (never on mount).
      React.useEffect(() => {
        const st = stateAt(windows, now);
        const last = lastKindRef.current;
        if (last !== null && last !== st.kind) fire(st.kind, st);
        lastKindRef.current = st.kind;
      }, [now, fire, windows]);

      // demo: simulate a 谷-start reminder shortly after load (for previews).
      React.useEffect(() => {
        if (!demo || demoFiredRef.current) return;
        demoFiredRef.current = true;
        const t = setTimeout(() => {
          const st = stateAt(windows, Date.now());
          fire("valley", { kind: "valley", endMin: st.mins + 180, mins: st.mins });
        }, 4000);
        return () => clearTimeout(t);
      }, [demo, fire, windows]);

      // Auto-dismiss.
      React.useEffect(() => {
        if (toast === null) return;
        const t = setTimeout(() => setToast(null), toastSeconds * 1000);
        return () => clearTimeout(t);
      }, [toast, toastSeconds]);

      const requestPerm = React.useCallback(() => {
        try {
          Notification.requestPermission().then((p) => setPerm(p));
        } catch (err) {}
      }, []);

      if (toast === null) return null;
      const valley = toast.kind === "valley";
      const title = valley ? "低谷时段开始" : "高峰时段开始";
      const sub = priceLine(prices, toast.kind);

      return h(
        "div",
        { className: "pva-toast", "data-state": toast.kind, onClick: () => setToast(null) },
        h("div", { className: "pva-goldline" }),
        h("div", { className: "pva-seal" }, valley ? "谷" : "峰"),
        h(
          "div",
          { className: "pva-body" },
          h("div", { className: "pva-title" }, title),
          h("div", { className: "pva-sub" }, sub),
          showBalance
            ? h(
                "div",
                { className: "pva-balance" },
                h("span", { className: "pva-balance-label" }, "余额"),
                h("span", null, balanceText())
              )
            : null,
          h(
            "div",
            { className: "pva-foot" },
            h("span", { className: "pva-hint" }, "点击关闭"),
            perm === "default"
              ? h(
                  "button",
                  { className: "pva-perm", onClick: (e) => { e.stopPropagation(); requestPerm(); } },
                  "开启系统通知"
                )
              : null
          )
        )
      );
    }

    // ----------------------------------------------------------------- apply
    const inject = ["slots"];

    function apply(ctx, config) {
      const c = config && typeof config === "object" ? config : {};
      const windows = resolveWindows(c);
      const prices = resolvePrices(c);
      const component = function PeakValleyAlarm() {
        return AlarmToast({
          windows,
          prices,
          sound: c.sound !== false,
          notify: c.notify !== false,
          toastSeconds: typeof c.toastSeconds === "number" ? c.toastSeconds : 8,
          demo: c.demo === true,
          showBalance: c.balance !== false,
          refreshMinutes:
            typeof c.balanceRefreshMinutes === "number" && c.balanceRefreshMinutes > 0
              ? c.balanceRefreshMinutes
              : 60,
        });
      };
      component.displayName = "PeakValleyAlarm";
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "peak-valley-alarm", order: 1, label: "省钱闹钟" },
          component
        )
      );
    }

    exports.name = "peak-valley-alarm";
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
