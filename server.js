import express from "express";
import path from "path";
import fs from "fs";
import { REPO_ROOT, repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { config, reloadScreeningThresholds } from "./config.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions, closePosition, claimFees } from "./tools/dlmm.js";
import { getTopCandidates } from "./tools/screening.js";
import { executeTool } from "./tools/executor.js";
import { getTrackedPositions } from "./state.js";
import { getPerformanceSummary } from "./lessons.js";
import { getRecentDecisions } from "./decision-log.js";
import { getPaperPositions, getPaperHistory, openPaperPosition, closePaperPosition, claimPaperFees, resetPaperData } from "./paper.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const ENV_PATH = repoPath(".env");
const LOG_DIR = repoPath("logs");

// In-memory log buffer (most recent 250 entries)
const logBuffer = [];

function addLogToBuffer(entry) {
  logBuffer.push(entry);
  if (logBuffer.length > 250) logBuffer.shift();
}

// Pre-fill buffer from today's log file if available
try {
  const today = new Date().toISOString().split("T")[0];
  const todayLog = path.join(LOG_DIR, `agent-${today}.log`);
  if (fs.existsSync(todayLog)) {
    const lines = fs.readFileSync(todayLog, "utf8").trim().split("\n");
    for (const line of lines.slice(-100)) {
      if (line) logBuffer.push({ text: line, time: Date.now() });
    }
  }
} catch { }

/**
 * Update DRY_RUN in .env file directly so it persists across bot restarts
 */
function updateEnvDryRun(isDryRun) {
  try {
    if (!fs.existsSync(ENV_PATH)) return;
    let content = fs.readFileSync(ENV_PATH, "utf8");
    if (/^DRY_RUN=/m.test(content)) {
      content = content.replace(/^DRY_RUN=.*/m, `DRY_RUN=${isDryRun}`);
    } else {
      content += `\nDRY_RUN=${isDryRun}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, "utf8");
  } catch (err) {
    log("server_error", `Failed to update .env: ${err.message}`);
  }
}

/**
 * Start Dashboard Web UI Server
 */
export function startDashboardServer(context = {}) {
  const app = express();
  const PORT = parseInt(process.env.PORT, 10) || 3456;
  const HOST = "0.0.0.0";

  app.use(express.json());

  // CORS & Security headers
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
  });

  // Serve static UI assets from /public
  app.use(express.static(path.join(REPO_ROOT, "public")));

  // ══════════════════════════════════════════════════════════
  //  API ROUTES
  // ══════════════════════════════════════════════════════════

  // 1. System & Bot Status
  app.get("/api/status", async (req, res) => {
    try {
      const isDryRun = process.env.DRY_RUN === "true";
      const balances = await getWalletBalances().catch(() => ({
        wallet: null,
        sol: 0,
        sol_usd: 0,
        sol_price: 0,
        total_usd: 0,
        tokens: []
      }));

      const timers = context.getTimers ? context.getTimers() : {
        managementLastRun: null,
        screeningLastRun: null,
        managementIntervalMin: config.schedule?.managementIntervalMin || 2,
        screeningIntervalMin: config.schedule?.screeningIntervalMin || 5
      };

      const tracked = getTrackedPositions ? getTrackedPositions(false) : [];
      const paperData = getPaperHistory();
      const openCount = isDryRun
        ? ((await getPaperPositions()).length)
        : tracked.filter(p => !p.closed).length;
      const perf = getPerformanceSummary ? getPerformanceSummary() : null;

      res.json({
        ok: true,
        botName: "Merione",
        mode: isDryRun ? "DRY_RUN" : "LIVE",
        dryRun: isDryRun,
        wallet: balances,
        solPrice: balances.sol_price || 0,
        activePositionsCount: openCount,
        cronRunning: context.getCronStatus ? context.getCronStatus() : true,
        enableLlm: config.llm?.enabled !== false,
        llmModel: config.llm?.screeningModel || config.llm?.managementModel || "None",
        timers,
        performance: perf,
        paperStats: paperData.stats,
        virtualWallet: paperData.virtualWallet,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 2. Positions (Active & History)
  app.get("/api/positions", async (req, res) => {
    try {
      const isDryRun = process.env.DRY_RUN === "true";
      let openPositions = [];
      let historyList = [];
      let stats = null;
      let virtualWallet = null;

      if (isDryRun) {
        const rawOpen = await getPaperPositions();
        openPositions = (rawOpen || []).map(p => ({
          ...p,
          bin_step: p.bin_step ?? p.binStep ?? null,
          binStep: p.bin_step ?? p.binStep ?? null
        }));
        const paperHist = getPaperHistory();
        stats = paperHist.stats;
        virtualWallet = paperHist.virtualWallet;

        historyList = (paperHist.history || []).map(h => {
          const pnlUsd = Number(h.pnlUsd ?? h.pnl_usd ?? h.close_pnl_usd ?? 0);
          const pnlSol = Number(h.pnlSol ?? h.pnl_sol ?? 0);
          const pnlPct = Number(h.pnlPct ?? h.pnl_pct ?? 0);
          const feesSol = Number(h.totalFeesSol ?? h.total_fees_sol ?? 0);
          const feesUsd = Number(h.totalFeesUsd ?? h.total_fees_usd ?? 0);
          const depSol = Number(h.depositSol ?? h.deposit_sol ?? 0);
          const depUsd = Number(h.depositUsd ?? h.deposit_usd ?? 0);
          const currSol = Number(h.currentValueSol ?? h.current_value_sol ?? (depSol + pnlSol));
          const currUsd = Number(h.currentValueUsd ?? h.current_value_usd ?? (depUsd + pnlUsd));

          return {
            ...h,
            pnl_usd: pnlUsd,
            pnl_sol: pnlSol,
            pnl_pct: pnlPct,
            pnlUsd,
            pnlSol,
            pnlPct,
            total_fees_sol: feesSol,
            total_fees_usd: feesUsd,
            totalFeesSol: feesSol,
            totalFeesUsd: feesUsd,
            deposit_sol: depSol,
            deposit_usd: depUsd,
            depositSol: depSol,
            depositUsd: depUsd,
            current_value_sol: currSol,
            current_value_usd: currUsd,
            currentValueSol: currSol,
            currentValueUsd: currUsd,
            closed_at: h.closedAt || h.closed_at,
            closedAt: h.closedAt || h.closed_at,
            close_reason: h.closeReason || h.close_reason || "Closed",
            closeReason: h.closeReason || h.close_reason || "Closed"
          };
        });
      } else {
        const live = await getMyPositions({ force: true }).catch(e => ({ positions: [], total_positions: 0 }));
        openPositions = live.positions || [];
        const allTracked = getTrackedPositions ? getTrackedPositions(false) : [];
        historyList = allTracked.filter(p => p.closed).slice(-30).reverse();
      }

      res.json({
        ok: true,
        dryRun: isDryRun,
        mode: isDryRun ? "DRY_RUN" : "LIVE",
        open: openPositions,
        history: historyList,
        stats,
        virtualWallet,
        count: openPositions.length
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 3. Manual Close Position
  app.post("/api/positions/close", async (req, res) => {
    try {
      const { position } = req.body;
      if (!position) return res.status(400).json({ ok: false, error: "Missing position address" });

      log("dashboard", `Manual close triggered for position ${position}`);
      addLogToBuffer({ text: `[MANUAL_CLOSE] Initiating close for ${position}`, time: Date.now() });

      const result = await executeTool("close_position", { position_address: position });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. Manual Claim Fees
  app.post("/api/positions/claim", async (req, res) => {
    try {
      const { position } = req.body;
      if (!position) return res.status(400).json({ ok: false, error: "Missing position address" });

      log("dashboard", `Manual fee claim triggered for position ${position}`);
      const result = await executeTool("claim_fees", { position_address: position });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4b. Paper Trading Endpoints (Deploy, History, Reset)
  app.post("/api/paper/deploy", async (req, res) => {
    try {
      const { pool_address, amount_sol, strategy, bins_below, bins_above, pool_name } = req.body;
      if (!pool_address) return res.status(400).json({ ok: false, error: "Missing pool_address" });

      const result = await openPaperPosition({
        pool_address,
        amount_sol,
        strategy,
        bins_below,
        bins_above,
        pool_name,
        source: "Manual (Web UI)"
      });

      addLogToBuffer({ text: `[PAPER_DEPLOY] Buka posisi simulasi pada ${result.pair || pool_address} (${result.amount_sol} SOL)`, time: Date.now() });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/paper/history", (req, res) => {
    try {
      res.json({ ok: true, ...getPaperHistory() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/paper/reset", (req, res) => {
    try {
      const result = resetPaperData();
      addLogToBuffer({ text: `[PAPER_RESET] Data simulasi di-reset ke kondisi awal`, time: Date.now() });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 5. Screening Radar Pools
  app.get("/api/screening", async (req, res) => {
    try {
      const candidates = await getTopCandidates({ limit: 15 }).catch(() => ({ candidates: [] }));
      res.json({ ok: true, candidates: candidates.candidates || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 6. Triggers (Screening / Management)
  app.post("/api/trigger/screen", async (req, res) => {
    try {
      if (context.runScreening) {
        context.runScreening();
        addLogToBuffer({ text: `[CRON_TRIGGER] Manual screening cycle triggered`, time: Date.now() });
        res.json({ ok: true, message: "Screening cycle started in background" });
      } else {
        res.status(400).json({ ok: false, error: "Screening trigger unavailable" });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/trigger/manage", async (req, res) => {
    try {
      if (context.runManagement) {
        context.runManagement();
        addLogToBuffer({ text: `[CRON_TRIGGER] Manual management cycle triggered`, time: Date.now() });
        res.json({ ok: true, message: "Management cycle started in background" });
      } else {
        res.status(400).json({ ok: false, error: "Management trigger unavailable" });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 7. Pause / Resume Cron
  app.post("/api/control/cron", (req, res) => {
    try {
      const { action } = req.body;
      if (context.toggleCron) {
        const status = context.toggleCron(action);
        res.json({ ok: true, status });
      } else {
        res.status(400).json({ ok: false, error: "Cron controller unavailable" });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 8. Get Configuration
  app.get("/api/config", (req, res) => {
    try {
      let userConfig = {};
      if (fs.existsSync(USER_CONFIG_PATH)) {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      }

      // Ensure dryRun matches current environment
      userConfig.dryRun = process.env.DRY_RUN === "true";
      userConfig.enableLlm = config.llm?.enabled ?? (userConfig.enableLlm !== false);

      res.json({
        ok: true,
        dryRun: process.env.DRY_RUN === "true",
        enableLlm: userConfig.enableLlm,
        mode: process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE",
        config: userConfig,
        runtime: {
          deployAmountSol: config.management?.deployAmountSol,
          maxPositions: config.management?.maxPositions,
          gasReserve: config.management?.gasReserve,
          takeProfitPct: config.management?.takeProfitPct,
          stopLossPct: config.management?.stopLossPct,
          strategy: config.management?.strategy
        }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 9. Update Configuration (Includes Live vs Dry Run setting!)
  app.post("/api/config", (req, res) => {
    try {
      const updates = req.body || {};
      let userConfig = {};
      if (fs.existsSync(USER_CONFIG_PATH)) {
        try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { }
      }

      // 1. Process dryRun change if provided
      if (updates.dryRun !== undefined) {
        const isDryRun = Boolean(updates.dryRun);
        userConfig.dryRun = isDryRun;
        process.env.DRY_RUN = String(isDryRun);
        updateEnvDryRun(isDryRun);
        log("config", `[MODE_SWITCH] Trading mode updated via Web UI -> ${isDryRun ? "🟡 DRY RUN (Paper)" : "🔴 LIVE TRADING"}`);
        addLogToBuffer({
          text: `[MODE_SWITCH] Trading mode changed to: ${isDryRun ? "DRY RUN (Simulasi)" : "LIVE TRADING (Real Mainnet)"}`,
          time: Date.now()
        });
      }

      // Process enableLlm change if provided
      if (updates.enableLlm !== undefined) {
        const isEnableLlm = Boolean(updates.enableLlm);
        userConfig.enableLlm = isEnableLlm;
        process.env.ENABLE_LLM = String(isEnableLlm);
        if (config.llm) config.llm.enabled = isEnableLlm;
        log("config", `[ENGINE_SWITCH] Decision engine updated via Web UI -> ${isEnableLlm ? "🧠 LLM Reasoning (AI Agent)" : "⚡ Mechanical Engine (No LLM)"}`);
        addLogToBuffer({
          text: `[ENGINE_SWITCH] Decision engine: ${isEnableLlm ? "🧠 LLM Reasoning (AI Agent)" : "⚡ Mechanical Engine (No LLM)"}`,
          time: Date.now()
        });
      }

      // 2. Merge other settings
      const allowedNumericFields = [
        "deployAmountSol", "maxPositions", "gasReserve", "positionSizePct",
        "takeProfitPct", "stopLossPct", "trailingTriggerPct", "trailingDropPct",
        "minTvl", "maxTvl", "minVolume", "minOrganic", "minQuoteOrganic", "minHolders",
        "minMcap", "maxMcap", "minBinStep", "maxBinStep", "minFeeActiveTvlRatio",
        "managementIntervalMin", "screeningIntervalMin", "outOfRangeBinsToClose", "outOfRangeWaitMinutes"
      ];

      for (const field of allowedNumericFields) {
        if (updates[field] !== undefined) {
          const val = Number(updates[field]);
          if (!isNaN(val)) userConfig[field] = val;
        }
      }

      if (updates.strategy && ["spot", "bid_ask", "curve"].includes(updates.strategy)) {
        userConfig.strategy = updates.strategy;
      }
      if (updates.timeframe) userConfig.timeframe = updates.timeframe;
      if (updates.category) userConfig.category = updates.category;
      if (updates.trailingTakeProfit !== undefined) {
        userConfig.trailingTakeProfit = Boolean(updates.trailingTakeProfit);
      }

      // 3. Write back to user-config.json
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2), "utf8");

      // 4. Update in-memory config
      if (config.management) {
        if (userConfig.deployAmountSol != null) config.management.deployAmountSol = userConfig.deployAmountSol;
        if (userConfig.maxPositions != null) config.management.maxPositions = userConfig.maxPositions;
        if (userConfig.gasReserve != null) config.management.gasReserve = userConfig.gasReserve;
        if (userConfig.takeProfitPct != null) config.management.takeProfitPct = userConfig.takeProfitPct;
        if (userConfig.stopLossPct != null) config.management.stopLossPct = userConfig.stopLossPct;
        if (userConfig.strategy) config.management.strategy = userConfig.strategy;
        if (userConfig.trailingTakeProfit !== undefined) config.management.trailingTakeProfit = userConfig.trailingTakeProfit;
      }

      // Reload thresholds if available
      try { reloadScreeningThresholds(); } catch { }

      res.json({
        ok: true,
        dryRun: process.env.DRY_RUN === "true",
        mode: process.env.DRY_RUN === "true" ? "DRY_RUN" : "LIVE",
        config: userConfig,
        message: "Pengaturan berhasil disimpan dan langsung diterapkan!"
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 10. Quick Mode Toggle (Dry Run <-> Live)
  app.post("/api/mode/toggle", (req, res) => {
    try {
      const current = process.env.DRY_RUN === "true";
      const next = !current;

      process.env.DRY_RUN = String(next);
      updateEnvDryRun(next);

      let userConfig = {};
      if (fs.existsSync(USER_CONFIG_PATH)) {
        try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { }
      }
      userConfig.dryRun = next;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2), "utf8");

      const modeName = next ? "DRY_RUN" : "LIVE";
      log("config", `[MODE_TOGGLE] Switched mode to ${modeName}`);
      addLogToBuffer({
        text: `[MODE_TOGGLE] Mode ditukar ke: ${next ? "DRY RUN (Simulasi)" : "LIVE TRADING"}`,
        time: Date.now()
      });

      res.json({
        ok: true,
        dryRun: next,
        mode: modeName,
        message: `Mode berhasil diubah menjadi ${next ? "DRY RUN (Simulasi)" : "LIVE TRADING"}`
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 11. Recent Activity / Logs
  app.get("/api/logs", (req, res) => {
    try {
      // Also fetch recent decisions
      const decisions = getRecentDecisions ? getRecentDecisions(15) : [];
      res.json({
        ok: true,
        logs: logBuffer.slice(-100).reverse(),
        decisions: decisions || []
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // SPA fallback
  app.use((req, res) => {
    const indexPath = path.join(REPO_ROOT, "public", "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.send(`<h2>Merione Dashboard Server Running on Port ${PORT}</h2><p>UI assets not found in public/ directory.</p>`);
    }
  });

  // Listen
  const server = app.listen(PORT, HOST, () => {
    log("dashboard", `Merione Web UI Dashboard aktif di http://${HOST}:${PORT}`);
    console.log(`\n==================================================`);
    console.log(` 🚀 MERIONE DASHBOARD ONLINE`);
    console.log(` 🌐 Akses Web UI: http://127.0.0.1:${PORT}`);
    console.log(` ⚙️ Mode Saat Ini : ${process.env.DRY_RUN === "true" ? "🟡 DRY RUN (Simulasi)" : "🔴 LIVE TRADING"}`);
    console.log(`==================================================\n`);
  });

  return server;
}

// Standalone execution support: `node server.js`
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startDashboardServer();
}
