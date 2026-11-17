/**
 * Merione Paper Trading & Dry Run Engine
 * 
 * Provides realistic simulation for Meteora DLMM LP positions:
 * - Opens simulated positions with real on-chain pool parameters (bin step, active bin, prices)
 * - Tracks live pool price movements, active bin changes, and in/out-of-range status
 * - Simulates realistic DLMM swap fee accrual based on 24h pool volume/fees & position concentration
 * - Calculates accurate unrealized and realized PnL (% and SOL/USD)
 * - Supports automatic and manual TP (Take Profit), SL (Stop Loss), and OOR (Out Of Range) exits
 * - Archives closed positions with performance history (win rate, total PnL, total fees)
 */

import fs from "fs";
import path from "path";
import { repoPath } from "./repo-root.js";
import { log } from "./logger.js";
import { getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { config } from "./config.js";

const PAPER_STATE_FILE = repoPath("paper-positions.json");

function getDefaultPaperState() {
  return {
    positions: [],
    history: [],
    stats: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRatePct: 0,
      totalNetPnlSol: 0,
      totalNetPnlUsd: 0,
      totalFeesSol: 0,
      totalFeesUsd: 0
    },
    virtualWallet: {
      initialSol: 10.0,
      currentSol: 10.0,
      inPositionsSol: 0.0
    },
    updatedAt: new Date().toISOString()
  };
}

export function loadPaperState() {
  if (!fs.existsSync(PAPER_STATE_FILE)) {
    const initial = getDefaultPaperState();
    savePaperState(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(PAPER_STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data.positions) data.positions = [];
    if (!data.history) data.history = [];
    if (!data.stats) data.stats = getDefaultPaperState().stats;
    if (!data.virtualWallet) data.virtualWallet = getDefaultPaperState().virtualWallet;
    return data;
  } catch (err) {
    log("paper_error", `Failed to parse paper-positions.json: ${err.message}`);
    return getDefaultPaperState();
  }
}

export function savePaperState(state) {
  try {
    state.updatedAt = new Date().toISOString();
    // Recompute wallet allocations
    const inPos = state.positions.reduce((acc, p) => acc + (Number(p.depositSol) || 0), 0);
    state.virtualWallet.inPositionsSol = Math.round(inPos * 10000) / 10000;
    fs.writeFileSync(PAPER_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    log("paper_error", `Failed to save paper-positions.json: ${err.message}`);
  }
}

/**
 * Fetch pool details from Meteora API with graceful fallback
 */
async function fetchPoolDetails(poolAddress) {
  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${poolAddress}`);
    if (res.ok) {
      return await res.json();
    }
  } catch {}
  return null;
}

/**
 * Open a simulated DLMM LP position
 */
export async function openPaperPosition({
  pool_address,
  amount_sol = null,
  strategy = "spot",
  bins_below = null,
  bins_above = 0,
  pool_name = null,
  source = "Auto (Screener)"
}) {
  const state = loadPaperState();

  // Guard against duplicate open position on same pool
  const existing = state.positions.find((p) => p.pool === pool_address && !p.closed);
  if (existing) {
    log("paper_warn", `Already have simulated position in pool ${pool_address}`);
    return { success: false, error: "Posisi simulasi sudah ada di pool ini", position: existing };
  }

  // Determine SOL amount to deploy
  const deploySol = Number(amount_sol || config.management?.deployAmountSol || 0.3);
  const activeBinsBelow = Number(bins_below ?? config.strategy?.defaultBinsBelow ?? 69);
  const activeBinsAbove = Number(bins_above ?? 0);

  // Fetch real on-chain / API active bin & price
  let activeBinData = null;
  try {
    activeBinData = await getActiveBin({ pool_address });
  } catch (err) {
    log("paper_error", `Could not get active bin for ${pool_address}: ${err.message}`);
  }

  // Fetch pool metadata from Meteora
  const poolData = await fetchPoolDetails(pool_address);

  const binStep = Number(poolData?.pool_config?.bin_step || 200);
  const activeBinId = activeBinData?.binId ?? 0;
  const currentPrice = Number(activeBinData?.price || poolData?.current_price || 0.0001);

  // Get current SOL USD price
  let solUsd = 72.0;
  try {
    const balances = await getWalletBalances();
    if (balances?.sol_price > 0) solUsd = balances.sol_price;
  } catch {}

  // Calculate DLMM bin range and price bounds
  const minBinId = activeBinId - activeBinsBelow;
  const maxBinId = activeBinsAbove > 0 ? activeBinId + activeBinsAbove : activeBinId;

  // Price = activePrice * (1 + binStep/10000)^deltaBins
  const minPrice = currentPrice * Math.pow(1 + binStep / 1e4, -activeBinsBelow);
  const maxPrice = activeBinsAbove > 0 
    ? currentPrice * Math.pow(1 + binStep / 1e4, activeBinsAbove) 
    : currentPrice;

  const pairName = pool_name || poolData?.name || `POOL-${pool_address.slice(0, 6)}`;
  const tokenXSymbol = poolData?.token_x?.symbol || pairName.split("-")[0] || "TOKEN";
  const tokenXMint = poolData?.token_x?.address || "";
  const tokenXDecimals = poolData?.token_x?.decimals || 6;

  const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const position = {
    id,
    position: id, // Address placeholder for compatibility
    is_paper: true,
    dry_run: true,
    pool: pool_address,
    pair: pairName,
    tokenXSymbol,
    tokenXMint,
    tokenXDecimals,
    strategy,
    
    // Deposit
    depositSol: deploySol,
    depositUsd: Math.round(deploySol * solUsd * 100) / 100,
    
    // Geometry & Pricing
    binStep,
    entryActiveBin: activeBinId,
    minBinId,
    maxBinId,
    entryPrice: currentPrice,
    entryPriceUsd: currentPrice * solUsd,
    minPrice,
    maxPrice,
    
    // Timestamps
    openedAt: new Date().toISOString(),
    lastPollAt: Date.now(),
    
    // Status & Movement
    lastActiveBin: activeBinId,
    lastPrice: currentPrice,
    lastSolUsd: solUsd,
    inRange: true,
    outOfRangeSince: null,
    minutesOutOfRange: 0,
    
    // Accrued simulated fees (SOL & USD)
    feeX: 0,
    feeY: 0,
    totalFeesSol: 0,
    totalFeesUsd: 0,
    claimedFeesSol: 0,
    claimedFeesUsd: 0,
    
    // Valuation & PnL
    currentValueSol: deploySol,
    currentValueUsd: Math.round(deploySol * solUsd * 100) / 100,
    pnlSol: 0,
    pnlUsd: 0,
    pnlPct: 0,
    peakPnlPct: 0,
    
    // Pool Market Snapshot at entry
    poolTvlUsd: poolData?.tvl || 5000,
    pool24hFeesUsd: poolData?.fees?.["24h"] || 500,
    pool24hVolumeUsd: poolData?.volume?.["24h"] || 20000,
    
    source,
    closed: false,
    closedAt: null,
    closeReason: null,
    notes: [`Simulasi dibuka via ${source}`]
  };

  state.positions.push(position);
  savePaperState(state);

  log("paper", `[DRY RUN] Buka posisi simulasi ${id} di ${pairName} | Modal: ${deploySol} SOL ($${(deploySol * solUsd).toFixed(2)})`);

  return {
    success: true,
    dry_run: true,
    position: id,
    pair: pairName,
    amount_sol: deploySol,
    entry_price: currentPrice,
    min_bin: minBinId,
    max_bin: maxBinId,
    message: `[DRY RUN SIMULASI] Sukses membuka posisi simulasi di ${pairName} (${deploySol} SOL)`
  };
}

/**
 * Update all active paper positions with live price, realistic fee accrual, and DLMM PnL
 */
export async function updatePaperPositions() {
  const state = loadPaperState();
  if (!state.positions || state.positions.length === 0) return [];

  let solUsd = 72.0;
  try {
    const balances = await getWalletBalances();
    if (balances?.sol_price > 0) solUsd = balances.sol_price;
  } catch {}

  const now = Date.now();
  let stateChanged = false;

  for (const pos of state.positions) {
    if (pos.closed) continue;

    try {
      // 1. Fetch live pool data & active bin
      let activeBinId = pos.lastActiveBin;
      let currPrice = pos.lastPrice;

      try {
        const binData = await getActiveBin({ pool_address: pos.pool });
        if (binData?.binId != null) activeBinId = binData.binId;
        if (Number(binData?.price) > 0) currPrice = Number(binData.price);
      } catch {}

      const poolData = await fetchPoolDetails(pos.pool);
      if (poolData?.current_price > 0) currPrice = Number(poolData.current_price);

      // 2. Compute elapsed time
      const lastPoll = pos.lastPollAt || Date.parse(pos.openedAt);
      const elapsedMin = Math.max(0.1, (now - lastPoll) / 60000);
      pos.lastPollAt = now;

      // 3. Check in-range status
      const inRange = activeBinId >= pos.minBinId && activeBinId <= pos.maxBinId;
      pos.inRange = inRange;
      pos.lastActiveBin = activeBinId;
      pos.lastPrice = currPrice;
      pos.lastSolUsd = solUsd;

      // 4. Simulate realistic DLMM fee accrual
      // Concentrated LP earns swap fees whenever pool executes trades in range
      const pool24hFees = Number(poolData?.fees?.["24h"] || pos.pool24hFeesUsd || 500);
      const poolTvl = Math.max(500, Number(poolData?.tvl || pos.poolTvlUsd || 5000));
      const feePerMinUsd = pool24hFees / 1440;

      // Pool share calculation: (deposit in USD) / (pool TVL)
      const depositUsd = pos.depositSol * solUsd;
      const baseShare = depositUsd / poolTvl;
      // In DLMM, concentrated liquidity has a multiplier over full-range TVL (approx 2.5x)
      const concentratedShare = Math.min(0.20, Math.max(0.0005, baseShare * 2.5));

      if (inRange && feePerMinUsd > 0) {
        const deltaFeeUsd = feePerMinUsd * elapsedMin * concentratedShare;
        const deltaFeeSol = deltaFeeUsd / solUsd;
        pos.feeY = (pos.feeY || 0) + deltaFeeSol;
        pos.totalFeesSol = pos.feeY;
        pos.totalFeesUsd = pos.feeY * solUsd;
      }

      // 5. Calculate DLMM Position Value & PnL
      let inventorySol = pos.depositSol;
      const priceRatio = pos.entryPrice > 0 ? (currPrice / pos.entryPrice) : 1;

      if (!inRange) {
        if (activeBinId < pos.minBinId) {
          // Price dumped completely below range -> 100% Token X
          inventorySol = pos.depositSol * priceRatio;
          if (!pos.outOfRangeSince) pos.outOfRangeSince = new Date().toISOString();
          pos.minutesOutOfRange = Math.floor((now - new Date(pos.outOfRangeSince).getTime()) / 60000);
        } else {
          // Price pumped above range -> 100% SOL (no IL, full capital preserved)
          inventorySol = pos.depositSol;
          pos.outOfRangeSince = null;
          pos.minutesOutOfRange = 0;
        }
      } else {
        // Price inside range: partial conversion to Token X
        pos.outOfRangeSince = null;
        pos.minutesOutOfRange = 0;
        const totalBins = Math.max(1, pos.maxBinId - pos.minBinId);
        const binsDown = Math.max(0, Math.min(totalBins, pos.maxBinId - activeBinId));
        const penetration = binsDown / totalBins;
        // Blended value: SOL portion + Token X portion
        inventorySol = pos.depositSol * ((1 - penetration) + penetration * priceRatio);
      }

      // Current total value = Inventory + Accrued Fees
      pos.currentValueSol = inventorySol + (pos.feeY || 0);
      pos.currentValueUsd = pos.currentValueSol * solUsd;

      // PnL in SOL and USD
      pos.pnlSol = pos.currentValueSol - pos.depositSol;
      pos.pnlPct = (pos.pnlSol / pos.depositSol) * 100;
      pos.pnlUsd = pos.pnlSol * solUsd;

      // Update Peak PnL
      pos.peakPnlPct = Math.max(pos.peakPnlPct || 0, pos.pnlPct);
      pos.ageMinutes = Math.floor((now - new Date(pos.openedAt).getTime()) / 60000);

      stateChanged = true;
    } catch (err) {
      log("paper_error", `Error updating paper pos ${pos.id}: ${err.message}`);
    }
  }

  if (stateChanged) savePaperState(state);
  return state.positions;
}

/**
 * Close a simulated position and record realized trade
 */
export async function closePaperPosition(positionId, reason = "Manual exit via Web UI") {
  const state = loadPaperState();
  const idx = state.positions.findIndex((p) => (p.id === positionId || p.position === positionId) && !p.closed);
  if (idx === -1) {
    throw new Error(`Posisi simulasi tidak ditemukan: ${positionId}`);
  }

  const pos = state.positions[idx];
  pos.closed = true;
  pos.closedAt = new Date().toISOString();
  pos.closeReason = reason;

  // Final stats update
  state.stats.totalTrades = (state.stats.totalTrades || 0) + 1;
  if (pos.pnlSol >= 0) {
    state.stats.winningTrades = (state.stats.winningTrades || 0) + 1;
  } else {
    state.stats.losingTrades = (state.stats.losingTrades || 0) + 1;
  }
  state.stats.winRatePct = Math.round((state.stats.winningTrades / state.stats.totalTrades) * 1000) / 10;
  state.stats.totalNetPnlSol = Math.round(((state.stats.totalNetPnlSol || 0) + pos.pnlSol) * 10000) / 10000;
  state.stats.totalNetPnlUsd = Math.round(((state.stats.totalNetPnlUsd || 0) + pos.pnlUsd) * 100) / 100;
  state.stats.totalFeesSol = Math.round(((state.stats.totalFeesSol || 0) + pos.feeY) * 10000) / 10000;
  state.stats.totalFeesUsd = Math.round(((state.stats.totalFeesUsd || 0) + pos.totalFeesUsd) * 100) / 100;

  // Add to history and remove from open positions
  state.history.unshift({ ...pos });
  if (state.history.length > 100) state.history.pop();
  state.positions.splice(idx, 1);

  savePaperState(state);

  log("paper", `[DRY RUN] Tutup posisi simulasi ${pos.pair} | PnL: ${pos.pnlPct.toFixed(2)}% (${pos.pnlSol >= 0 ? '+' : ''}${pos.pnlSol.toFixed(4)} SOL / $${pos.pnlUsd.toFixed(2)}) | Alasan: ${reason}`);

  return {
    success: true,
    closed_position: pos,
    pnlSol: pos.pnlSol,
    pnlUsd: pos.pnlUsd,
    pnlPct: pos.pnlPct,
    feesSol: pos.feeY,
    feesUsd: pos.totalFeesUsd,
    reason
  };
}

/**
 * Claim fees for a simulated position
 */
export async function claimPaperFees(positionId) {
  const state = loadPaperState();
  const pos = state.positions.find((p) => (p.id === positionId || p.position === positionId) && !p.closed);
  if (!pos) throw new Error(`Posisi simulasi tidak ditemukan: ${positionId}`);

  const claimedSol = pos.feeY || 0;
  const claimedUsd = pos.totalFeesUsd || 0;

  pos.claimedFeesSol = (pos.claimedFeesSol || 0) + claimedSol;
  pos.claimedFeesUsd = (pos.claimedFeesUsd || 0) + claimedUsd;
  pos.feeY = 0;
  pos.totalFeesSol = 0;
  pos.totalFeesUsd = 0;

  state.stats.totalFeesSol = Math.round(((state.stats.totalFeesSol || 0) + claimedSol) * 10000) / 10000;
  state.stats.totalFeesUsd = Math.round(((state.stats.totalFeesUsd || 0) + claimedUsd) * 100) / 100;

  savePaperState(state);
  log("paper", `[DRY RUN] Klaim fee posisi simulasi ${pos.pair} sebesar ${claimedSol.toFixed(4)} SOL ($${claimedUsd.toFixed(2)})`);

  return {
    success: true,
    claimed_sol: claimedSol,
    claimed_usd: claimedUsd
  };
}

/**
 * Get active paper positions formatted identically to DLMM real positions
 */
export async function getPaperPositions() {
  await updatePaperPositions();
  const state = loadPaperState();
  const openPositions = state.positions.filter((p) => !p.closed);

  return openPositions.map((p) => ({
    position: p.id,
    pool: p.pool,
    pair: p.pair,
    token_x_symbol: p.tokenXSymbol,
    token_x_mint: p.tokenXMint,
    token_x_decimals: p.tokenXDecimals,
    in_range: p.inRange,
    total_value_usd: Math.round(p.currentValueUsd * 100) / 100,
    total_value_sol: Math.round(p.currentValueSol * 10000) / 10000,
    unclaimed_fees_usd: Math.round(p.totalFeesUsd * 100) / 100,
    unclaimed_fees_sol: Math.round(p.totalFeesSol * 1000000) / 1000000,
    pnl_usd: Math.round(p.pnlUsd * 100) / 100,
    pnl_sol: Math.round(p.pnlSol * 10000) / 10000,
    pnl_pct: Math.round(p.pnlPct * 100) / 100,
    peak_pnl_pct: Math.round(p.peakPnlPct * 100) / 100,
    deposit_sol: p.depositSol,
    deposit_usd: p.depositUsd,
    entry_price: p.entryPrice,
    current_price: p.lastPrice,
    bin_step: p.binStep ?? p.bin_step ?? null,
    binStep: p.binStep ?? p.bin_step ?? null,
    lower_bin: p.minBinId,
    upper_bin: p.maxBinId,
    active_bin: p.lastActiveBin,
    min_price: p.minPrice,
    max_price: p.maxPrice,
    age_minutes: p.ageMinutes || 0,
    fee_per_tvl_24h: p.poolTvlUsd > 0 ? Math.round(((p.pool24hFeesUsd / p.poolTvlUsd) * 100) * 100) / 100 : 5.0,
    is_paper: true,
    dry_run: true,
    opened_at: p.openedAt,
    notes: p.notes || []
  }));
}

/**
 * Get closed paper history & performance summary
 */
export function getPaperHistory() {
  const state = loadPaperState();
  return {
    stats: state.stats,
    history: state.history,
    virtualWallet: state.virtualWallet
  };
}

/**
 * Reset paper trading data (for testing / fresh simulation run)
 */
export function resetPaperData() {
  const initial = getDefaultPaperState();
  savePaperState(initial);
  return { success: true, message: "Data paper trading berhasil di-reset" };
}
