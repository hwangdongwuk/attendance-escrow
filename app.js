// 출석 보증금 에스크로 프론트. config.js / abi.js는 scripts/deploy.js가 생성한다.
(() => {
  "use strict";

  const CFG = window.APP_CONFIG || null;
  const ABI = window.APP_ABI || null;
  const LOCAL_CHAIN = 31337;
  const SEPOLIA = 11155111;
  const LOG_CHUNK = 5000;      // eth_getLogs 한 번에 조회할 블록 수 (RPC 범위 제한 대응)
  const LOG_LOOKBACK = 50000;  // config.js에 deployBlock이 없을 때 거슬러 볼 블록 수
  const POLL_MS = 15000;
  const MODULES = ["", "Blockchain Cryptography", "Blockchain Storage", "Ethereum State Machine", "Smart Contract Basics", "Solidity Language", "Solidity Core", "Solidity Governance"];
  const ATT = ["대기", "출석", "지각", "결석", "공결"];
  const ATT_CLS = ["mute", "ok", "warn", "warn", "blue"];
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const TABS = ["home", "deposit", "proof", "attest", "settle", "excuse", "log"];
  const ERR_KO = {
    NotMember: "등록된 스터디원 지갑이 아니에요", WrongState: "지금 상태에서는 할 수 없는 동작이에요",
    AlreadyDeposited: "이미 예치했어요", DepositWindowClosed: "예치 기한이 지났어요",
    DepositWindowOpen: "아직 예치 기한이 남아 있어요", RoundNotOpen: "열린 회차가 없어요",
    PreviousRoundNotSettled: "이전 회차를 먼저 정산해야 해요", AllRoundsDone: "모든 회차가 끝났어요",
    ProofAlreadySubmitted: "이번 회차 증빙을 이미 제출했어요", ProofWindowClosed: "증빙 제출 기간이 끝났어요",
    EmptyHash: "해시가 비어 있어요", SelfAttest: "내 증빙은 내가 확인할 수 없어요", NoProof: "아직 증빙을 제출하지 않은 스터디원이에요",
    AlreadyAttested: "이미 확인했어요", AttestWindowClosed: "확인 기간이 끝났어요",
    TooEarlyToSettle: "확인 마감 전에는 정산할 수 없어요", AlreadySettled: "이미 정산된 회차예요",
    NotAdmin: "배포자만 할 수 있어요", InvalidRound: "회차 번호가 잘못됐어요",
    NotAllSettled: "모든 회차를 정산한 뒤에 최종 정산할 수 있어요", NothingToWithdraw: "인출할 금액이 없어요",
    ERC20InsufficientAllowance: "SDT 사용 승인이 부족해요. 다시 눌러 승인부터 진행해 주세요",
    ERC20InsufficientBalance: "SDT 잔액이 부족해요. 테스트 SDT를 먼저 받아 주세요",
  };

  const $ = (id) => document.getElementById(id);
  const fmt = (v) => Number(ethers.formatUnits(v, 18)).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  const short = (a) => a ? a.slice(0, 6) + "…" + a.slice(-4) : "-";
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const ts = (t) => {
    if (!t) return "-";
    const d = new Date(Number(t) * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const remain = (deadline, now) => {
    const d = Number(deadline) - now;
    if (d <= 0) return "마감 지남";
    const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60);
    return h >= 24 ? `${Math.floor(h / 24)}일 ${h % 24}시간 남음` : h > 0 ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
  };
  const nm = (i) => "스터디원 " + String.fromCharCode(65 + i);
  const name = (members, a) => { const i = members.findIndex(x => same(x, a)); return i >= 0 ? nm(i) : short(a); };
  const av = (i, dim) => `<span class="av av${i % 8}${dim ? " dim" : ""}" aria-hidden="true">${String.fromCharCode(65 + i)}</span>`;
  const emptyRow = (t) => `<li class="li empty-row">${t}</li>`;
  const sha256File = async (file) => {
    const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return "0x" + Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
  };
  const explorer = (kind, v) => CFG?.chainId === SEPOLIA ? `https://sepolia.etherscan.io/${kind}/${v}` : null;

  // 실행 환경: 공개 페이지는 테스트넷 배포 전까지 지갑 연결을 막고 샘플만 보여 준다.
  const isLocalPage = ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
  const chainIsLocal = CFG?.chainId === LOCAL_CHAIN;
  const canDemo = !!CFG && !!ABI && isLocalPage && chainIsLocal;
  const canWallet = !!CFG && !!ABI && (!chainIsLocal || isLocalPage);
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  let provider, signer, me, escrow, sdt, sbt, ifaceAll, demo = false, timer = null, connected = false, listening = false;
  let S = {};                 // 화면 상태 (연결 전엔 샘플, 연결 후엔 체인 조회값)
  const SCENARIOS = ["deposit", "proof", "attest", "ready", "settled", "finished"];
  const scParam = new URLSearchParams(location.search).get("sc");  // ?sc=deposit 처럼 샘플 상황을 바로 열 수 있다
  let scenario = SCENARIOS.includes(scParam) ? scParam : "attest";
  let logs = [], logsTo = null, logsPartial = false;
  let pendingHash = null, pendingFile = null, pendingAt = null;
  let verifyTarget = null, verified = {};  // "회차:주소" → true/false
  let refreshSeq = 0, busy = false;
  const steps = { s1: false, s2: false };
  const actions = {};         // 화면별 주 버튼 동작

  // ---------- 샘플 상태 (연결 전) ----------
  function sampleState(sc) {
    const hexFill = (seed, n) => ethers.id("sample-" + seed).slice(2, 2 + n);
    const E = 10n ** 18n, per = 5000n * E, rounds = 7, threshold = 3;
    const members = Array.from({ length: 6 }, (_, i) => "0x" + hexFill(i + 1, 40));
    const now = Math.floor(Date.now() / 1000);
    const cfg = { perRound: per, rounds, threshold, depositWindow: 3 * 86400, submitWindow: 7 * 86400, lateWindow: 86400, attestWindow: 86400 };
    const Z = ethers.ZeroHash;
    const mr = (i, has, att) => ({ proofHash: has ? "0x" + hexFill(i + 11, 64) : Z, late: false, attestCount: BigInt(att), status: 0n, proofAt: has ? now - 26 * 3600 - i * 1800 : 0 });
    const mkHist = (round, statuses) => {
      const refundOf = (s) => s === 1 || s === 4 ? per : s === 2 ? per / 2n : 0n;
      const pool = statuses.reduce((acc, s) => acc + (per - refundOf(s)), 0n);
      const present = statuses.filter(s => s === 1).length;
      const share = present > 0 ? pool / BigInt(present) : 0n;
      const rows = statuses.map((s, i) => ({ addr: members[i], i, status: s, attestCount: s === 1 || s === 2 ? 3 : 0, refund: refundOf(s), share: s === 1 ? share : 0n, got: refundOf(s) + (s === 1 ? share : 0n) }));
      const count = [0, 0, 0, 0, 0]; rows.forEach(x => count[x.status]++);
      return { round, rd: { settled: true, pool, presentCount: BigInt(present) }, rows, present, share, remainder: pool - share * BigInt(present), count, mine: rows[0] };
    };
    const ALL = [1, 1, 1, 1, 1, 1], ONE_ABSENT = [1, 1, 1, 1, 1, 3];
    const histOf = (n) => Array.from({ length: n }, (_, i) => mkHist(n - i, n - i === 3 || n - i === 4 ? ONE_ABSENT : ALL));
    const base = {
      members, cfg, rounds, threshold, now, myIdx: 0, isMember: true, isAdmin: false,
      sdtBal: 0n, allowance: 0n, depFlags: Array(6).fill(true), depCount: 6, myDep: true,
      total: per * BigInt(rounds), depDeadline: now - 30 * 86400, attestedByMe: [], myAttesters: [],
    };
    const withHist = (n) => {
      const hist = histOf(n), returned = hist.reduce((acc, h) => acc + h.mine.got, 0n);
      return { hist, returned, settledN: n, locked: per * BigInt(rounds - n), bal: returned, att: n, sbtBal: n };
    };
    const openRd = (p, a) => ({ settled: false, proofDeadline: p, lateDeadline: p + 86400, attestDeadline: a, pool: 0n, presentCount: 0n });

    if (sc === "deposit") {
      return { ...base, st: 0, r: 0, rd: null, phase: 0, hist: [], returned: 0n, settledN: 0, locked: 0n, bal: 0n, att: 0, sbtBal: 0, sdtBal: 100000n * E,
        depFlags: [false, true, true, true, true, false], depCount: 4, myDep: false, depDeadline: now + 2 * 86400 + 3600, mrs: [], mine: null, hasProof: false };
    }
    if (sc === "proof") {
      const mrs = [mr(0, false, 0), mr(1, true, 2), mr(2, true, 1), mr(3, true, 0), mr(4, false, 0), mr(5, false, 0)];
      return { ...base, ...withHist(3), st: 1, r: 4, rd: openRd(now + 2 * 86400, now + 4 * 86400), phase: 1, mrs, mine: mrs[0], hasProof: false, attestedByMe: Array(6).fill(false) };
    }
    if (sc === "ready") {
      const mrs = [mr(0, true, 3), mr(1, true, 3), mr(2, true, 3), mr(3, true, 4), mr(4, true, 3), mr(5, false, 0)];
      return { ...base, ...withHist(3), st: 1, r: 4, rd: openRd(now - 2 * 86400, now - 3600), phase: 4, mrs, mine: mrs[0], hasProof: true,
        attestedByMe: [false, true, true, true, true, false], myAttesters: [members[1], members[3], members[4]] };
    }
    if (sc === "settled") {
      const mrs = [mr(0, true, 3), mr(1, true, 3), mr(2, true, 3), mr(3, true, 4), mr(4, true, 3), mr(5, false, 0)];
      const rd = { settled: true, proofDeadline: now - 3 * 86400, lateDeadline: now - 2 * 86400, attestDeadline: now - 86400, pool: per, presentCount: 5n };
      return { ...base, ...withHist(4), st: 1, r: 4, rd, phase: 5, mrs, mine: mrs[0], hasProof: true, attestedByMe: Array(6).fill(false) };
    }
    if (sc === "finished") {
      const rd = { settled: true, proofDeadline: now - 3 * 86400, lateDeadline: now - 2 * 86400, attestDeadline: now - 86400, pool: 0n, presentCount: 6n };
      const mrs = Array.from({ length: 6 }, (_, i) => mr(i, true, 3));
      return { ...base, ...withHist(7), st: 3, r: 7, rd, phase: 5, mrs, mine: mrs[0], hasProof: true, attestedByMe: Array(6).fill(false) };
    }
    // attest (기본): PPT 샘플 화면과 같은 상황. 4회차 상호 확인 중, 내 증빙 2/3
    const mrs = [mr(0, true, 2), mr(1, true, 3), mr(2, true, 1), mr(3, true, 3), mr(4, true, 2), mr(5, false, 0)];
    return { ...base, ...withHist(3), st: 1, r: 4, rd: openRd(now - 20 * 3600, now + 31 * 3600), phase: 3, mrs, mine: mrs[0], hasProof: true,
      attestedByMe: [false, true, false, true, false, false], myAttesters: [members[1], members[3]] };
  }
  function sampleLog() {
    const m = S.members;
    return [
      `[48] 4회차 확인 ${nm(3)} → ${nm(0)} (2)`, `[47] 4회차 확인 ${nm(1)} → ${nm(0)} (1)`,
      `[45] 4회차 증빙 ${nm(0)} 0x9f2c…a71e`, `[41] 4회차 시작`,
      `[40] 3회차 정산 출석 5명 풀 5,000 1인 1,000`, `[40] 3회차 분배 ${nm(0)} +1,000 SDT`,
      `[40] 3회차 판정 ${nm(5)} 결석 환급 0`, `[40] 3회차 판정 ${nm(0)} 출석 환급 5,000`,
      `[27] 2회차 정산 출석 6명 풀 0 1인 0`, `[14] 1회차 정산 출석 6명 풀 0 1인 0`,
      `[9] 1회차 시작`, `[8] 스터디 시작`,
      ...m.map((a, i) => `[${7 - i}] 예치 ${nm(i)} 35,000 SDT`).reverse(),
    ].join("\n");
  }
  function enterSample() {
    S = sampleState(scenario);
    $("sampleBar").hidden = false;
    document.querySelectorAll("[data-sc]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sc === scenario)));
    $("sampleText").innerHTML = canWallet || canDemo
      ? "<strong>샘플 화면이에요.</strong> 지갑을 연결하면 실제 기록이 보여요."
      : "<strong>샘플 화면이에요.</strong> 테스트넷 컨트랙트를 연결하기 전이라 실제 거래는 일어나지 않아요.";
    $("eventLog").textContent = sampleLog();
    renderContracts();
    $("netLabel").textContent = !CFG ? "config.js가 없어요. 먼저 배포 스크립트를 실행해 주세요."
      : chainIsLocal ? "로컬 개발 체인 주소예요. 테스트넷 배포 후 이 자리에 실제 주소가 표시돼요." : `${CFG.network} · chainId ${CFG.chainId}`;
    renderAll();
  }

  // ---------- 메시지 ----------
  let msgTimer = null;
  function msg(text, cls, link) {
    const el = $("msg");
    clearTimeout(msgTimer);
    el.className = "toast " + (cls || "");
    el.textContent = text;
    if (link) {
      const a = document.createElement("a");
      a.href = link; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = " Etherscan에서 보기";
      el.appendChild(a);
    }
    el.hidden = false;
    if (cls !== "pending") msgTimer = setTimeout(() => { el.hidden = true; }, cls === "err" ? 12000 : 6000);
  }
  $("msg").addEventListener("click", (e) => { if (e.target.tagName !== "A") $("msg").hidden = true; });

  function explain(e) {
    const data = e?.data || e?.info?.error?.data || e?.error?.data;
    if (ifaceAll && typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      try { const p = ifaceAll.parseError(data); if (p) return ERR_KO[p.name] || p.name; } catch (_) { /* 알 수 없는 에러 데이터 */ }
    }
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001 || e?.info?.error?.code === 4001) return "지갑에서 서명을 거부했어요";
    const m = e?.shortMessage || e?.reason || e?.message || String(e);
    for (const k of Object.keys(ERR_KO)) if (m.includes(k)) return ERR_KO[k];
    return m.length > 200 ? m.slice(0, 200) + "…" : m;
  }

  // 트랜잭션은 한 번에 하나만. 서명 대기 중 중복 클릭으로 두 번 나가는 것을 막는다.
  async function tx(label, fn) {
    if (!connected) {
      msg("샘플 화면이라 실제로 처리되지는 않아요.", "");
      return false;
    }
    if (busy) return false;
    busy = true; document.body.classList.add("busy");
    try {
      msg(label + " · 지갑에서 서명해 주세요", "pending");
      const t = await fn();
      msg(label + " · 블록에 기록되는 중이에요 " + short(t.hash), "pending", explorer("tx", t.hash));
      const r = await t.wait();
      msg(label + " 완료 (블록 " + r.blockNumber + ")", "ok", explorer("tx", t.hash));
      await refresh();
      return true;
    } catch (e) {
      console.error(e);
      msg(label + " 실패: " + explain(e), "err");
      return false;
    } finally {
      busy = false; document.body.classList.remove("busy");
    }
  }

  // ---------- 지갑 시트 ----------
  function setupSheet() {
    const mode = $("mode"); mode.innerHTML = "";
    const add = (sel, v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); };
    if (canDemo) add(mode, "demo", "로컬 데모 (Hardhat 계정)");
    if (canWallet) add(mode, "metamask", "MetaMask 지갑");
    $("modeField").hidden = mode.options.length < 2 && !canDemo;
    const acc = $("demoAccount"); acc.innerHTML = "";
    if (canDemo) {
      add(acc, 0, "배포자(관리자) · 계정0");
      (CFG.members || []).forEach((m, i) => add(acc, i + 1, `${nm(i)} · ${short(m)}`));
      acc.value = "1";
    }
    updateSheet();
  }
  function updateSheet() {
    const isDemoMode = $("mode").value === "demo";
    $("demoAccountField").hidden = !isDemoMode;
    $("connectForm").hidden = connected || (!canWallet && !canDemo);
    $("connectedInfo").hidden = !connected;
    const noWallet = !connected && canWallet && !isDemoMode && !window.ethereum;
    $("installLink").hidden = !noWallet;
    $("btnConnect").textContent = noWallet && isMobile ? "MetaMask 앱에서 열기" : "연결하기";
    $("btnConnect").hidden = noWallet && !isMobile;
    $("sheetTitle").textContent = connected ? "지갑" : "지갑 연결";
    $("connectHint").textContent = connected ? "" : !canWallet && !canDemo
      ? "테스트넷 컨트랙트를 배포하면 지갑을 연결할 수 있어요. 지금은 샘플 화면으로 흐름을 둘러볼 수 있어요."
      : isDemoMode ? "이 PC에서 Hardhat 노드가 돌고 있어야 해요. 서명 창 없이 바로 처리돼요."
      : noWallet ? (isMobile ? "모바일에서는 MetaMask 앱 안의 브라우저에서 열어야 해요." : "이 브라우저에 MetaMask가 없어요. 설치한 뒤 새로고침해 주세요.")
      : `${chainName()} 네트워크의 테스트 지갑으로 연결해요. 네트워크가 다르면 전환을 요청해요.`;
    if (connected) { $("sheetAddr").textContent = short(me); $("sheetNet").textContent = chainName(); }
  }
  const chainName = () => CFG?.chainId === SEPOLIA ? "Sepolia 테스트넷" : CFG?.chainId === LOCAL_CHAIN ? "로컬 Hardhat" : `chainId ${CFG?.chainId}`;
  const openSheet = () => { updateSheet(); if (!$("sheet").open) $("sheet").showModal(); };
  const closeSheet = () => { if ($("sheet").open) $("sheet").close(); };

  $("walletChip").addEventListener("click", openSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  $("mode").addEventListener("change", updateSheet);
  $("btnConnect").addEventListener("click", () => {
    if ($("mode").value !== "demo" && !window.ethereum && isMobile) {
      location.href = `https://metamask.app.link/dapp/${location.host}${location.pathname}`;
      return;
    }
    connect();
  });
  $("demoAccount").addEventListener("change", () => { if (connected && demo) connect(); });
  $("btnDisconnect").addEventListener("click", disconnect);

  // ---------- 연결 ----------
  async function ensureChain() {
    const want = "0x" + CFG.chainId.toString(16);
    const cur = await window.ethereum.request({ method: "eth_chainId" });
    if (cur.toLowerCase() === want) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      if (e.code !== 4902 || CFG.chainId !== SEPOLIA) throw e;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: want, chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"], blockExplorerUrls: ["https://sepolia.etherscan.io"],
      }] });
    }
  }
  function remember(on) {
    try { on ? localStorage.setItem("ae.wallet", "1") : localStorage.removeItem("ae.wallet"); } catch (_) { /* 저장 불가 환경은 무시 */ }
  }
  async function connect() {
    try {
      if (!CFG || !ABI) throw new Error("config.js 또는 abi.js가 없어요. 먼저 배포 스크립트를 실행해 주세요.");
      demo = $("mode").value === "demo";
      if (demo) {
        provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
        signer = await provider.getSigner(Number($("demoAccount").value));
      } else {
        if (!window.ethereum) throw new Error("MetaMask가 없어요.");
        await window.ethereum.request({ method: "eth_requestAccounts" });
        await ensureChain();
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        if (!listening) {
          listening = true;
          window.ethereum.on?.("accountsChanged", (a) => { if (!a.length) disconnect(); else if (connected) connect(); });
          window.ethereum.on?.("chainChanged", () => location.reload());
        }
        remember(true);
      }
      me = await signer.getAddress();
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== CFG.chainId) throw new Error(`연결된 체인(${net.chainId})이 배포 체인(${CFG.chainId})과 달라요.`);
      if (await provider.getCode(CFG.escrow) === "0x") throw new Error("이 체인에서 컨트랙트를 찾지 못했어요. 노드를 재시작했다면 다시 배포해 주세요.");
      escrow = new ethers.Contract(CFG.escrow, ABI.StudyEscrow, signer);
      sdt = new ethers.Contract(CFG.sdt, ABI.MockSDT, signer);
      sbt = new ethers.Contract(CFG.sbt, ABI.AttendanceSBT, signer);
      ifaceAll = new ethers.Interface([...ABI.StudyEscrow, ...ABI.MockSDT.filter(f => f.type === "error"), ...ABI.AttendanceSBT.filter(f => f.type === "error")]);
      logs = []; logsTo = null; logsPartial = false;
      await refresh();
      connected = true;
      $("walletChip").classList.remove("off");
      $("walletText").textContent = short(me);
      $("sampleBar").hidden = true;
      $("demoPanel").hidden = !demo;
      renderContracts();
      $("netLabel").textContent = `${chainName()} · chainId ${net.chainId}`;
      renderAll();
      closeSheet();
      msg("연결됐어요 " + short(me), "ok");
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden && !busy) refresh().catch(() => {}); }, POLL_MS);
    } catch (e) {
      console.error(e);
      connected = false;
      msg("연결 실패: " + explain(e) + (demo ? "\n이 PC에서 Hardhat 노드가 돌고 있는지 확인해 주세요." : ""), "err");
    }
  }
  function disconnect() {
    clearInterval(timer); timer = null;
    connected = false; demo = false; escrow = sdt = sbt = signer = provider = me = null; logs = []; logsTo = null;
    remember(false);
    $("walletChip").classList.add("off");
    $("walletText").textContent = "지갑 연결";
    $("demoPanel").hidden = true;
    closeSheet();
    enterSample();
  }

  // ---------- 조회 ----------
  async function refresh() {
    if (!escrow) return;
    const seq = ++refreshSeq;
    const [members, cfg, state, curRound, depCount, block, admin, createdAt] = await Promise.all([
      escrow.getMembers(), escrow.config(), escrow.state(), escrow.currentRound(),
      escrow.depositedCount(), provider.getBlock("latest"), escrow.admin(), escrow.createdAt(),
    ]);
    const now = Number(block.timestamp);
    const r = Number(curRound), st = Number(state);
    const rounds = Number(cfg.rounds), threshold = Number(cfg.threshold);
    const myIdx = members.findIndex(a => same(a, me));
    const isMember = myIdx >= 0;
    const isAdmin = same(admin, me);
    const [sdtBal, locked, bal, att, sbtBal, allowance] = await Promise.all([
      sdt.balanceOf(me), escrow.lockedOf(me), escrow.balanceOf(me), escrow.attendCount(me), sbt.balanceOf(me), sdt.allowance(me, CFG.escrow),
    ]);
    const rd = r > 0 ? await escrow.getRound(r) : null;
    const phase = Number(await escrow.phase());
    const depFlags = await Promise.all(members.map(a => escrow.deposited(a)));
    const myDep = isMember && depFlags[myIdx];
    const total = cfg.perRound * BigInt(rounds);
    const depDeadline = Number(createdAt) + Number(cfg.depositWindow);
    const mrs = r > 0 ? await Promise.all(members.map(a => escrow.getMemberRound(r, a))) : [];
    const mine = isMember && r > 0 ? mrs[myIdx] : null;
    const hasProof = !!(mine && mine.proofHash !== ethers.ZeroHash);
    const attestedByMe = r > 0 ? await Promise.all(members.map(a => escrow.hasAttested(r, a, me))) : [];
    const myAttesters = hasProof ? await escrow.getAttesters(r, me) : [];

    const settledN = r > 0 ? (rd.settled ? r : r - 1) : 0;
    const hist = [];
    for (let k = settledN; k >= 1; k--) {
      const krd = k === r ? rd : await escrow.getRound(k);
      const kmrs = k === r ? mrs : await Promise.all(members.map(a => escrow.getMemberRound(k, a)));
      const present = Number(krd.presentCount);
      const share = present > 0 ? krd.pool / BigInt(present) : 0n;
      const remainder = present > 0 ? krd.pool - share * BigInt(present) : krd.pool;
      const rows = members.map((a, i) => {
        const s = Number(kmrs[i].status);
        const refund = s === 1 || s === 4 ? cfg.perRound : s === 2 ? cfg.perRound / 2n : 0n;
        return { addr: a, i, status: s, attestCount: Number(kmrs[i].attestCount), refund, share: s === 1 ? share : 0n, got: refund + (s === 1 ? share : 0n) };
      });
      const count = [0, 0, 0, 0, 0]; rows.forEach(x => count[x.status]++);
      hist.push({ round: k, rd: krd, rows, present, share, remainder, count, mine: isMember ? rows[myIdx] : null });
    }
    const returned = hist.reduce((acc, h) => acc + (h.mine ? h.mine.got : 0n), 0n);
    await loadEvents(Number(block.number));
    if (seq !== refreshSeq) return;  // 더 최근 조회가 시작됐으면 이 결과는 버린다

    S = { members, cfg, st, r, rd, rounds, threshold, now, myIdx, isMember, isAdmin, sdtBal, locked, bal, att: Number(att), sbtBal: Number(sbtBal),
          allowance, phase, depFlags, depCount: Number(depCount), myDep, total, depDeadline, mrs, mine, hasProof, attestedByMe, myAttesters, hist, returned, settledN };
    renderAll();
    renderLog();
  }

  // 이벤트는 새 블록만 이어서 조회하고, RPC 범위 제한에 걸리지 않게 구간을 나눈다.
  async function loadEvents(latest) {
    const start = logsTo !== null ? logsTo + 1 : Number.isInteger(CFG.deployBlock) ? CFG.deployBlock : chainIsLocal ? 0 : Math.max(0, latest - LOG_LOOKBACK);
    const iface = new ethers.Interface(ABI.StudyEscrow);
    try {
      for (let from = start; from <= latest; from += LOG_CHUNK) {
        const to = Math.min(from + LOG_CHUNK - 1, latest);
        const got = await provider.getLogs({ address: CFG.escrow, fromBlock: from, toBlock: to });
        for (const l of got) {
          const p = iface.parseLog(l);
          if (p) logs.push({ block: l.blockNumber, name: p.name, args: p.args });
        }
        logsTo = to;
      }
      logsPartial = false;
    } catch (e) {
      console.error(e);
      logsPartial = true;
    }
  }
  function renderLog() {
    const who = (a) => name(S.members || [], a);
    const line = ({ block: b, name: n, args: a }) => {
      switch (n) {
        case "Deposited": return `[${b}] 예치 ${who(a.member)} ${fmt(a.amount)} SDT`;
        case "StudyStarted": return `[${b}] 스터디 시작`;
        case "StudyCancelled": return `[${b}] 스터디 취소`;
        case "Refunded": return `[${b}] 환불 ${who(a.member)} ${fmt(a.amount)} SDT`;
        case "RoundOpened": return `[${b}] ${a.round}회차 시작 (확인 마감 ${ts(a.attestDeadline)})`;
        case "ProofSubmitted": return `[${b}] ${a.round}회차 증빙 ${who(a.member)} ${short(a.proofHash)}${a.late ? " 지각" : ""}`;
        case "Attested": return `[${b}] ${a.round}회차 확인 ${who(a.attester)} → ${who(a.member)} (${a.count})`;
        case "ExcuseSet": return `[${b}] ${a.round}회차 공결 ${who(a.member)}`;
        case "AttendanceJudged": return `[${b}] ${a.round}회차 판정 ${who(a.member)} ${ATT[Number(a.status)]} 환급 ${fmt(a.refund)}`;
        case "RoundSettled": return `[${b}] ${a.round}회차 정산 출석 ${a.presentCount}명 풀 ${fmt(a.pool)} 1인 ${fmt(a.sharePerPresent)}`;
        case "Distributed": return `[${b}] ${a.round === 0n ? "최종" : a.round + "회차"} 분배 ${who(a.member)} +${fmt(a.amount)} SDT`;
        case "StudyFinalized": return `[${b}] 최종 정산 개근 ${a.perfectCount}명 잔액 ${fmt(a.leftover)}`;
        case "Withdrawn": return `[${b}] 인출 ${who(a.member)} ${fmt(a.amount)} SDT`;
        default: return `[${b}] ${n}`;
      }
    };
    const text = logs.map(line).reverse().join("\n");
    $("eventLog").textContent = (logsPartial ? "일부 기록을 불러오지 못했어요. 잠시 뒤 다시 시도해요.\n" : "") + (text || "아직 기록이 없어요");
  }
  const excusedList = () => logs.filter(l => l.name === "ExcuseSet").map(l => ({ round: Number(l.args.round), member: l.args.member }));

  // ---------- 렌더 ----------
  function renderAll() { renderHome(); renderDeposit(); renderProof(); renderAttest(); renderSettle(); renderExcuse(); renderActions(); }

  function setStep(id, state, em) {
    const el = $(id), b = el.querySelector("b");
    b.className = state === "done" ? "" : state;
    const e = el.querySelector("em"); if (e && em !== undefined) e.textContent = em;
  }

  function renderHome() {
    const { st, r, rd, rounds, threshold, now, isMember, locked, bal, phase, myDep, hasProof, mine, hist, returned, settledN, depCount, members } = S;
    const need = members.length - depCount;
    $("homeSub").textContent = !isMember ? (S.isAdmin ? "배포자 지갑으로 연결했어요" : "등록된 스터디원 지갑이 아니에요")
      : st === 0 ? "전원이 예치하면 스터디가 시작돼요" : st === 2 ? "예치 기한 안에 전원이 넣지 않아 취소됐어요"
      : st === 3 ? "모든 회차가 끝났어요" : `${members.length}명 · ${rounds}회차 · 확인 ${threshold}명이면 출석`;
    $("homeLocked").textContent = fmt(locked);
    const pct = Math.round(100 * settledN / rounds);
    $("homeBar").style.width = pct + "%";
    $("homeProg").setAttribute("aria-valuenow", String(pct));
    $("homeBarText").textContent = st === 0 ? `예치 ${depCount} / ${members.length}명 · 시작 전` : st === 2 ? "취소됨 · 전액 환불"
      : st === 3 ? `${settledN} / ${rounds}회차 완료` : `${settledN} / ${rounds}회차 정산됨`;

    let k = "", t = "", d = "";
    if (!isMember) { k = S.isAdmin ? "배포자" : "안내"; t = S.isAdmin ? "운영만 할 수 있어요" : "스터디원 지갑으로 연결해 주세요"; d = S.isAdmin ? "회차 열기와 공결 처리를 할 수 있어요." : "이 지갑은 스터디에 등록되어 있지 않아요."; }
    else if (st === 0) { k = "시작 전"; t = "보증금 예치"; d = myDep ? `${need}명이 더 넣으면 스터디가 시작돼요.` : `${fmt(S.total)} SDT를 넣으면 돼요. ${ts(S.depDeadline)}까지 · ${remain(S.depDeadline, now)}`; }
    else if (st === 1 && r > 0 && !rd.settled) {
      k = `이번 회차 · 모듈 ${r}`; t = MODULES[r] || `모듈 ${r}`;
      if (phase === 1) d = hasProof ? "증빙을 냈어요. 이제 다른 스터디원 증빙을 확인해 주세요." : `${ts(rd.proofDeadline)} 마감 · ${remain(rd.proofDeadline, now)}`;
      else if (phase === 2) d = hasProof ? "증빙을 냈어요. 다른 스터디원 증빙을 확인해 주세요." : `제출 마감이 지났어요. ${ts(rd.lateDeadline)}까지 내면 지각으로 접수되고 회차 몫의 절반만 돌아와요.`;
      else if (phase === 3) d = hasProof ? `확인 ${mine.attestCount} / ${threshold} · 확인 마감 ${remain(rd.attestDeadline, now)}` : "제출 기간이 끝났어요. 이번 회차는 결석이에요.";
      else d = "확인 마감이 지났어요. 누구든 정산을 누르면 환급과 분배가 한 번에 처리돼요.";
    } else if (st === 1) { k = r === 0 ? "시작" : "정산 완료"; t = r < rounds ? `다음 · 모듈 ${r + 1}` : "최종 정산"; d = r < rounds ? `${MODULES[r + 1] || ""}. 회차를 열면 그 시각부터 제출 기간이 시작돼요.` : "모든 회차가 정산됐어요. 최종 정산을 누르면 개근 배지와 잔액 분배가 처리돼요."; }
    else { k = st === 2 ? "취소" : "종료"; t = st === 2 ? "스터디 취소" : "스터디 종료"; d = bal > 0n ? "돌려받을 금액이 있어요. 아래에서 인출해 주세요." : "정산이 모두 끝났어요."; }
    $("taskK").textContent = k; $("taskT").textContent = t; $("taskD").textContent = d;

    const showPhases = st === 1 && r > 0 && !rd.settled;
    $("phaseSteps").hidden = !showPhases;
    if (showPhases) {
      const names = ["증빙 제출", "지각 접수", "상호 확인", "정산"];
      $("phaseSteps").innerHTML = names.map((n, i) => {
        const cls = i + 1 < phase ? "past" : i + 1 === phase ? "now" : "";
        return `<li class="${cls}"${i + 1 === phase ? ' aria-current="step"' : ""}>${n}</li>`;
      }).join("");
    }

    const statusOf = (n) => hist.find(h => h.round === n)?.mine?.status;
    const presentN = hist.filter(h => h.mine?.status === 1).length;
    $("roundSummary").textContent = settledN ? `출석 ${presentN} / ${settledN}` : "";
    $("roundGrid").innerHTML = Array.from({ length: rounds }, (_, i) => {
      const n = i + 1, s = statusOf(n), isNow = st === 1 && n === r && !rd.settled;
      const label = `${n}회차 ${MODULES[n] || ""}: ${s ? ATT[s] : isNow ? "진행 중" : "예정"}`;
      return `<li class="${s ? "s" + s : isNow ? "now" : ""}" title="${label}" aria-label="${label}">${n}</li>`;
    }).join("");

    $("homeReturned").textContent = "+" + fmt(returned);
    $("homeList").innerHTML = hist.slice(0, 3).map(h => {
      const m = h.mine, stn = m ? m.status : 0;
      const label = `${h.round}회차 · 출석 ${h.present}명${h.count[3] ? ` · 결석 ${h.count[3]}명` : ""}${h.count[2] ? ` · 지각 ${h.count[2]}명` : ""}${h.count[4] ? ` · 공결 ${h.count[4]}명` : ""}`;
      const right = !m ? "" : m.got > 0n ? `<span class="r ok">+${fmt(m.got)}</span>` : `<span class="r warn">${ATT[stn]}</span>`;
      return `<li class="li"><span class="av num" aria-hidden="true">${h.round}</span><span class="who">${label}</span>${right}</li>`;
    }).join("") || emptyRow("정산된 회차가 생기면 여기에 쌓여요");
    $("btnWithdraw").hidden = bal <= 0n;
    $("btnWithdraw").textContent = `인출 가능 ${fmt(bal)} SDT · 내 지갑으로 보내기`;
  }

  function renderDeposit() {
    const { st, members, depFlags, depCount, myDep, total, cfg, rounds, depDeadline, now, sdtBal, isMember } = S;
    const all = depCount === members.length;
    $("depSub").textContent = st !== 0 ? "예치는 끝났어요" : myDep ? "내 보증금은 들어가 있어요" : "보증금을 걸면 스터디가 시작돼요";
    $("depTotal").textContent = fmt(total);
    $("depDesc").textContent = `${rounds}회 × ${fmt(cfg.perRound)} SDT`;
    $("depNote").textContent = st === 0
      ? `${ts(depDeadline)}까지 전원이 예치하면 스터디가 시작돼요 (${remain(depDeadline, now)}). 기한 안에 다 넣지 않으면 넣은 금액은 전액 돌려받아요.`
      : st === 2 ? "예치 기한 안에 전원이 넣지 않아 취소됐어요. 넣은 금액은 홈에서 인출할 수 있어요." : "전원이 예치해서 스터디가 시작됐어요. 출석할 때마다 회차 몫이 돌아오고, 결석한 사람 몫은 출석한 사람들이 나눠 가져요.";
    $("depChip").textContent = `${depCount} / ${members.length}명`;
    $("depChip").className = "chip sm " + (all ? "ok" : "warn");
    $("depList").innerHTML = members.map((a, i) =>
      `<li class="li">${av(i, !depFlags[i])}<span class="who">${nm(i)}${i === S.myIdx ? ' <span class="me-tag">· 나</span>' : ""}<small class="mono">${short(a)}</small></span>${depFlags[i] ? `<span class="done">완료</span>` : `<span class="r">아직</span>`}</li>`).join("");
    $("sdtBal").textContent = fmt(sdtBal);
    $("btnFaucet").disabled = connected && !(demo || isMember);
    $("btnCancel").hidden = !(st === 0 && now > depDeadline);
  }

  function renderProof() {
    const { r, rd, phase, hasProof, mine, threshold, now, isMember, myAttesters, members, mrs } = S;
    const open = r > 0 && !rd.settled;
    $("proofH1").textContent = r > 0 ? `모듈 ${r} 증빙 제출` : "증빙 제출";
    $("proofSub").textContent = !open ? "지금은 낼 증빙이 없어요" : MODULES[r] || `${r}회차`;
    if (hasProof) {
      setStep("step1", "done", "완료"); setStep("step2", "done", "완료"); setStep("step3", "done", "제출됨");
      $("step3Text").textContent = mine.late ? "캡처 파일 제출 · 지각 접수" : "캡처 파일 제출";
      $("proofBox").textContent = `제출 ${ts(mine.proofAt)}`;
      $("proofHash").className = "hash"; $("proofHash").textContent = mine.proofHash;
    } else {
      setStep("step1", steps.s1 ? "done" : "off", steps.s1 ? "체크함" : "눌러서 체크");
      setStep("step2", steps.s2 ? "done" : "off", steps.s2 ? "체크함" : "눌러서 체크");
      setStep("step3", pendingHash ? "done" : "off", pendingFile ? "선택됨" : "탭해서 선택");
      $("step3Text").textContent = "캡처 파일 선택";
      $("proofBox").textContent = pendingFile ? `${pendingFile} · ${ts(pendingAt)}` : "파일을 고르면 이름과 시각이 여기에 표시돼요";
      $("proofHash").className = "hash" + (pendingHash ? "" : " empty"); $("proofHash").textContent = pendingHash || "파일을 고르면 이 기기에서 해시를 계산해요";
    }
    $("step1").setAttribute("aria-pressed", String(hasProof || steps.s1));
    $("step2").setAttribute("aria-pressed", String(hasProof || steps.s2));
    $("dupWarn").hidden = !(pendingHash && !hasProof && mrs.some((x, i) => i !== S.myIdx && x.proofHash === pendingHash));
    const due = $("proofDue");
    if (!open) { due.textContent = "열린 회차가 없어요"; due.className = "due mute"; }
    else if (phase === 1) { due.textContent = `마감 ${ts(rd.proofDeadline)} · ${remain(rd.proofDeadline, now)}`; due.className = "due"; }
    else if (phase === 2) { due.textContent = `지각 접수 ${ts(rd.lateDeadline)}까지 · 회차 몫의 절반만 돌아와요`; due.className = "due"; }
    else { due.textContent = hasProof ? `제출 완료 · 확인 마감 ${remain(rd.attestDeadline, now)}` : "제출 기간이 끝났어요"; due.className = "due mute"; }
    $("myAttCard").hidden = !hasProof;
    if (hasProof) {
      $("myAttChip").textContent = `${mine.attestCount} / ${threshold}`;
      $("myAttChip").className = "chip sm " + (Number(mine.attestCount) >= threshold ? "ok" : "mute");
      $("myAttesters").innerHTML = myAttesters.length ? myAttesters.map(a => {
        const i = members.findIndex(x => same(x, a));
        return `<li class="li">${av(Math.max(i, 0))}<span class="who">${name(members, a)}</span><span class="done">확인함</span></li>`;
      }).join("") : emptyRow("아직 확인한 사람이 없어요");
    }
    const lock = hasProof || !open || !isMember || phase > 2;
    $("step1").disabled = $("step2").disabled = lock;
    $("step3").classList.toggle("locked", lock);
    $("proofFile").disabled = lock;
  }

  function renderAttest() {
    const { r, rd, phase, threshold, hasProof, mine, now, members, mrs, attestedByMe, isMember, myIdx } = S;
    const open = r > 0 && !rd.settled;
    const n = hasProof ? Number(mine.attestCount) : 0;
    $("attN").textContent = n; $("attD").textContent = threshold;
    $("attSub").textContent = !open ? "열린 회차가 없어요" : `본인 제외 ${members.length - 1}명 중 ${threshold}명이 확인하면 출석이에요`;
    const canAttest = isMember && open && phase <= 3;
    const hashes = mrs.map(x => x.proofHash);
    $("attestList").innerHTML = !open ? emptyRow("열린 회차가 없어요") : members.map((a, i) => {
      if (i === myIdx) return "";
      const x = mrs[i], p = x.proofHash !== ethers.ZeroHash;
      const key = `${r}:${a}`, v = verified[key];
      const dup = p && hashes.filter(h => h === x.proofHash).length > 1;
      const tag = v === true ? ' <span class="chip sm ok">캡처 일치</span>' : v === false ? ' <span class="chip sm warn">캡처 불일치</span>' : dup ? ' <span class="chip sm warn">중복 해시</span>' : "";
      const acts = !p ? `<span class="r">증빙 미제출</span>`
        : `<span class="acts"><button class="sbtn line" data-verify="${a}" type="button" aria-label="${nm(i)} 캡처 대조">대조</button>${attestedByMe[i] ? `<span class="done">확인함</span>` : `<button class="sbtn" data-attest="${a}" type="button" aria-label="${nm(i)} 증빙 확인" ${canAttest ? "" : "disabled"}>확인</button>`}</span>`;
      return `<li class="li">${av(i, !p)}<span class="who">${nm(i)}${tag}<small>${p ? `<span class="mono">${short(x.proofHash)}</span>${x.late ? " · 지각" : ""} · 확인 ${x.attestCount}/${threshold}` : "-"}</small></span>${acts}</li>`;
    }).join("");
    document.querySelectorAll("[data-attest]").forEach(b => { b.onclick = () => tx("확인 서명", () => escrow.attest(b.dataset.attest)); });
    document.querySelectorAll("[data-verify]").forEach(b => { b.onclick = () => { verifyTarget = b.dataset.verify; $("verifyFile").click(); }; });
    const due = $("attDue");
    if (!open) { due.textContent = "-"; due.className = "due mute"; }
    else if (phase <= 3) { due.textContent = `확인 마감 ${remain(rd.attestDeadline, now)}`; due.className = "due"; }
    else { due.textContent = "확인 마감이 지났어요 · 정산할 수 있어요"; due.className = "due mute"; }
  }

  function renderSettle() {
    const { st, r, rd, rounds, hist, cfg, sbtBal, bal } = S;
    const last = hist[0];
    if (!last) {
      $("setH1").textContent = "정산"; $("setSub").textContent = "아직 정산된 회차가 없어요";
      $("setChips").innerHTML = ""; $("setAmtCard").hidden = true; $("setCard").hidden = true;
      $("sbtBadge").hidden = true; $("judgeCard").hidden = true;
    } else {
      const m = last.mine;
      $("setAmtCard").hidden = false; $("setCard").hidden = false;
      $("setH1").textContent = `${last.round}회차 정산 완료`;
      $("setSub").textContent = !m ? "스터디원별 결과예요" : m.got > 0n ? `${ATT[m.status]} · ${fmt(m.got)} SDT가 돌아왔어요` : `${ATT[m.status]} · 이번 회차 몫은 출석자에게 나눠졌어요`;
      $("setChips").innerHTML = [[1, "출석", "ok"], [2, "지각", "warn"], [3, "결석", "warn"], [4, "공결", "blue"]].filter(([k]) => last.count[k]).map(([k, t, c]) => `<span class="chip ${c}">${t} ${last.count[k]}명</span>`).join("");
      $("setMine").textContent = m ? fmt(m.got) : "-";
      $("setRefund").textContent = m ? fmt(m.refund) : "-";
      $("setShareLabel").textContent = last.present ? `결석 분배 (${fmt(last.rd.pool)} ÷ ${last.present}명)` : "결석 분배 (출석자 없음 · 이월)";
      $("setShare").textContent = m ? `+${fmt(m.share)}` : "-";
      $("setRemain").textContent = fmt(last.remainder);
      // SBT는 출석(Present)에게만 발행된다. 공결·지각은 발행되지 않는다 (StudyEscrow.settleRound).
      $("sbtBadge").hidden = !(m && m.status === 1);
      $("sbtBadgeText").textContent = `출석 SBT 발행 · 내 지갑에 ${sbtBal}개`;
      $("judgeCard").hidden = false;
      $("judgeList").innerHTML = last.rows.map(x => `<li class="li">${av(x.i, x.status === 3)}<span class="who">${nm(x.i)}${x.i === S.myIdx ? ' <span class="me-tag">· 나</span>' : ""}<small>확인 ${x.attestCount}</small></span><span class="chip sm ${ATT_CLS[x.status]}">${ATT[x.status]}</span><span class="r wide ${x.got > 0n ? "ok" : ""}">${x.got > 0n ? "+" + fmt(x.got) : "0"}</span></li>`).join("");
    }
    const active = st === 1;
    if (!active) {
      $("nextTitle").textContent = st === 3 ? "스터디가 끝났어요" : st === 2 ? "스터디가 취소됐어요" : "아직 시작 전이에요";
      $("nextDesc").textContent = st === 0 ? "전원이 예치하면 스터디가 시작돼요." : bal > 0n ? "돌려받을 금액을 인출할 수 있어요." : "돌려받을 금액이 없어요.";
    } else if (r === 0 || rd.settled) {
      if (r < rounds) { $("nextTitle").textContent = `${r + 1}회차를 열 수 있어요`; $("nextDesc").textContent = `모듈 ${r + 1} · ${MODULES[r + 1] || ""}. 여는 시각부터 ${Math.round(Number(cfg.submitWindow) / 3600)}시간 동안 증빙을 낼 수 있어요.`; }
      else { $("nextTitle").textContent = "최종 정산만 남았어요"; $("nextDesc").textContent = "개근한 스터디원에게 개근 배지를 주고, 남은 잔액을 개근자(없으면 전원)에게 나눠요. 그다음 홈에서 인출해요."; }
    } else {
      $("nextTitle").textContent = `${r}회차 진행 중`;
      $("nextDesc").textContent = S.phase === 4 ? "확인 마감이 지났어요. 정산하면 환급, 분배, 출석 SBT 발행이 한 번에 처리돼요." : `확인 마감 ${ts(rd.attestDeadline)} 뒤에 정산할 수 있어요.`;
    }
    document.querySelector('.tabs [data-tab="settle"] .dot').classList.toggle("on", connected && active && S.isMember && r > 0 && !rd.settled && S.phase === 4);
  }

  // 공결: 연결 전엔 투표 예시, 연결 후엔 처리된 건 + 배포자 처리
  let voteYes = 2;
  function renderVote() {
    $("voteYes").textContent = voteYes;
    $("voteBar").innerHTML = Array.from({ length: 4 }, (_, i) => `<i class="${i < voteYes ? "on" : ""}"></i>`).join("");
    $("voteSub").textContent = voteYes >= 3 ? "기준 충족 · 5회차 몫이 면제돼요" : "신청자 제외 5명 중 과반";
    $("voteOk").disabled = $("voteNo").disabled = voteYes !== 2;
  }
  $("voteOk").addEventListener("click", () => { voteYes = 3; renderVote(); });
  $("voteNo").addEventListener("click", () => { $("voteSub").textContent = "반대했어요 · 찬성 2 / 기준 3"; $("voteOk").disabled = $("voteNo").disabled = true; });
  function renderExcuse() {
    const { members, isAdmin, rounds } = S;
    const list = connected ? excusedList() : [];
    $("voteWrap").hidden = connected;
    $("excuseList").innerHTML = list.length ? list.map(x => {
      const i = members.findIndex(a => same(a, x.member));
      return `<li class="li">${av(i >= 0 ? i : 7)}<span class="who">${name(members, x.member)}<small>${x.round}회차</small></span><span class="chip sm blue">공결</span></li>`;
    }).join("") : emptyRow("아직 없어요");
    $("excuseAdmin").hidden = !(connected && isAdmin);
    if (connected && isAdmin) {
      const sel = $("excuseMember"), keep = sel.value;
      sel.innerHTML = members.map((a, i) => `<option value="${a}">${nm(i)}</option>`).join("");
      if (keep) sel.value = keep;
      $("excuseRound").max = rounds;
    }
  }

  function renderContracts() {
    const rows = [["에스크로", CFG?.escrow], ["SDT 토큰", CFG?.sdt], ["출석 SBT", CFG?.sbt]];
    $("contractList").innerHTML = rows.map(([label, a]) => {
      const url = a && explorer("address", a);
      const text = a || "-";
      return `<li class="li"><span class="who">${label}<small class="mono addr">${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text}</small></span>${a ? `<button class="iconbtn" data-copy="${a}" type="button" aria-label="${label} 주소 복사"><svg class="ic" aria-hidden="true"><use href="#i-copy"/></svg></button>` : ""}</li>`;
    }).join("");
  }
  $("contractList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copy); msg("주소를 복사했어요", "ok"); }
    catch (_) { msg("복사하지 못했어요. 주소를 직접 선택해 주세요.", "err"); }
  });

  // 화면별 주 버튼
  function renderActions() {
    const { st, r, rd, rounds, phase, myDep, isMember, hasProof, bal, now, depDeadline, total, sdtBal } = S;
    const active = st === 1, open = r > 0 && !rd.settled;
    const openNext = { t: `${r + 1}회차 열기`, f: () => tx("회차 열기", () => escrow.openRound()) };
    const settle = { t: `${r}회차 정산하기`, f: () => tx("회차 정산", () => escrow.settleRound()) };
    const finalize = { t: "최종 정산하기", f: () => tx("최종 정산", () => escrow.finalizeStudy()) };
    const A = {};
    // 홈
    if (!isMember) A.home = S.isAdmin && active && (r === 0 || rd.settled) && r < rounds ? openNext : { t: "스터디원 지갑으로 바꾸기", f: openSheet };
    else if (st === 0 && !myDep) A.home = { t: "보증금 예치하러 가기", f: () => go("deposit") };
    else if (st === 0) A.home = { t: "다른 스터디원 예치를 기다리는 중", dis: true };
    else if (active && open && phase <= 2 && !hasProof) A.home = { t: "학습 증빙 제출", f: () => go("proof") };
    else if (active && open && phase <= 3) A.home = { t: "스터디원 증빙 확인하기", f: () => go("attest") };
    else if (active && open && phase === 4) A.home = settle;
    else if (active && r < rounds) A.home = openNext;
    else if (active) A.home = finalize;
    else if (bal > 0n) A.home = { t: `${fmt(bal)} SDT 인출하기`, f: () => tx("인출", () => escrow.withdraw()) };
    else A.home = { t: "끝났어요", dis: true };
    // 예치
    if (st !== 0) A.deposit = { t: "예치가 끝났어요", dis: true };
    else if (!isMember) A.deposit = { t: "스터디원 지갑만 예치할 수 있어요", dis: true };
    else if (myDep) A.deposit = { t: "예치 완료", dis: true };
    else if (now > depDeadline) A.deposit = { t: "예치 기한이 지났어요", dis: true };
    else if (sdtBal < total) A.deposit = { t: `SDT가 ${fmt(total - sdtBal)} 부족해요 · 테스트 SDT 받기`, f: faucet, ghost: true };
    else A.deposit = { t: "지갑으로 예치하기", f: depositFlow };
    // 증빙
    if (!open || !isMember) A.proof = { t: "지금은 낼 증빙이 없어요", dis: true };
    else if (hasProof) A.proof = { t: "제출 완료 · 확인하러 가기", ghost: true, f: () => go("attest") };
    else if (phase > 2) A.proof = { t: "제출 기간이 끝났어요", dis: true };
    else A.proof = { t: phase === 2 ? "지각으로 증빙 제출" : "증빙 제출", dis: !(steps.s1 && steps.s2 && pendingHash), f: () => tx("증빙 제출", () => escrow.submitProof(pendingHash)) };
    // 정산
    if (!active) A.settle = { t: bal > 0n ? `${fmt(bal)} SDT 인출하기` : "정산이 끝났어요", dis: bal === 0n, f: () => tx("인출", () => escrow.withdraw()) };
    else if (open && phase === 4) A.settle = settle;
    else if (open) A.settle = { t: "확인 마감 뒤에 정산할 수 있어요", dis: true };
    else if (r < rounds) A.settle = openNext;
    else A.settle = finalize;

    for (const [tab, a] of Object.entries(A)) {
      const b = document.querySelector(`[data-slot="${tab}"]`);
      const flush = b.classList.contains("flush");
      b.textContent = a.t; b.disabled = !!a.dis;
      b.className = "btn" + (flush ? " flush" : "") + (a.ghost ? " ghost" : "");
      actions[tab] = a.f || null;
    }
    const dot = (tab, on) => document.querySelector(`.tabs [data-tab="${tab}"] .dot`).classList.toggle("on", !!on);
    dot("home", false);
    dot("proof", connected && isMember && open && phase <= 2 && !hasProof);
    dot("deposit", connected && isMember && st === 0 && !myDep);
    dot("attest", connected && isMember && open && phase <= 3 && S.mrs.some((x, i) => i !== S.myIdx && x.proofHash !== ethers.ZeroHash && !S.attestedByMe[i]));
  }
  document.querySelectorAll("[data-slot]").forEach(b => b.addEventListener("click", () => { const f = actions[b.dataset.slot]; if (f) f(); }));

  // ---------- 동작 ----------
  const faucet = () => tx("테스트 SDT 받기", () => sdt.faucet(ethers.parseUnits("100000", 18)));
  async function depositFlow() {
    if (!connected) return tx("예치", null);
    const { allowance, total } = S;
    if (allowance < total) {
      const ok = await tx("SDT 사용 승인 (1/2)", () => sdt.approve(CFG.escrow, total));
      if (!ok) return;
    }
    await tx("보증금 예치 (2/2)", () => escrow.deposit());
  }
  $("btnFaucet").addEventListener("click", faucet);
  $("btnCancel").addEventListener("click", () => tx("스터디 취소·환불", () => escrow.cancelStudy()));
  $("btnWithdraw").addEventListener("click", () => tx("인출", () => escrow.withdraw()));
  $("btnExcuse").addEventListener("click", () => tx("공결 처리", () => escrow.setExcuse(Number($("excuseRound").value), $("excuseMember").value)));
  $("step1").addEventListener("click", () => { steps.s1 = !steps.s1; renderProof(); renderActions(); });
  $("step2").addEventListener("click", () => { steps.s2 = !steps.s2; renderProof(); renderActions(); });
  $("proofFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    pendingHash = await sha256File(f);
    pendingFile = f.name; pendingAt = Math.floor(Date.now() / 1000);
    renderProof(); renderActions();
  });
  $("verifyFile").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; ev.target.value = "";
    if (!f || !verifyTarget) return;
    const i = S.members.findIndex(a => same(a, verifyTarget));
    const ok = (await sha256File(f)) === S.mrs[i].proofHash;
    verified[`${S.r}:${verifyTarget}`] = ok;
    msg(ok ? `${nm(i)}가 제출한 해시와 같은 파일이에요.` : `${nm(i)}가 제출한 해시와 달라요. 같은 원본인지 확인해 주세요.`, ok ? "ok" : "err");
    renderAttest();
  });
  document.querySelectorAll("[data-ff]").forEach(b => { b.onclick = async () => {
    try {
      await provider.send("evm_increaseTime", [Number(b.dataset.ff)]);
      await provider.send("evm_mine", []);
      msg(`체인 시각을 ${b.textContent} 앞당겼어요`, "ok");
      await refresh();
    } catch (e) { msg("시간 조작 실패: " + explain(e), "err"); }
  }; });
  document.querySelectorAll("[data-sc]").forEach(b => { b.onclick = () => {
    scenario = b.dataset.sc; pendingHash = pendingFile = pendingAt = null; steps.s1 = steps.s2 = false; verified = {};
    enterSample();
  }; });

  // ---------- 화면 전환 (주소 #해시와 동기화해 뒤로 가기·공유가 동작) ----------
  function show(tab, focus) {
    if (!TABS.includes(tab)) tab = "home";
    document.querySelectorAll(".tabs a").forEach(a => {
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    let heading = null;
    document.querySelectorAll("section[data-screen]").forEach(s => {
      s.hidden = s.dataset.screen !== tab;
      if (!s.hidden) heading = s.querySelector("h2");
    });
    window.scrollTo({ top: 0 });
    if (focus && heading) heading.focus({ preventScroll: true });
  }
  function go(tab) {
    if (location.hash === "#" + tab) show(tab, true); else location.hash = tab;
  }
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (TABS.includes(id)) show(id, true);
    else if (id !== "main") show("home", true);
  });

  // ---------- 시작 ----------
  setupSheet();
  renderVote();
  enterSample();
  show(location.hash.slice(1), false);
  (async () => {
    // 이미 승인한 지갑이면 새로고침 뒤에도 연결을 유지한다 (네트워크 전환 시 페이지가 다시 로드됨).
    let wanted = false;
    try { wanted = localStorage.getItem("ae.wallet") === "1"; } catch (_) { /* 저장 불가 환경은 무시 */ }
    if (!wanted || !canWallet || !window.ethereum) return;
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts.length) { $("mode").value = "metamask"; await connect(); }
    } catch (e) { console.error(e); }
  })();
})();
