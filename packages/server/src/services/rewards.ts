import { prisma } from "../database.js";
import {
  CREDITS_PER_GB_PER_DAY,
  TIER_MULTIPLIER,
  BYTES_PER_CREDIT,
  NODE_OFFLINE_THRESHOLD_MS,
} from "@swarmvault/shared";

/**
 * Uptime reward ramp.
 *
 * Below 50% uptime → 0 reward (node is too unreliable to store data for others).
 * 50% → 80%        → linear ramp from 0 to full reward.
 * 80%+             → full reward (1.0× multiplier).
 *
 * This means a node at 65% earns about half credit, and someone who goes on a
 * month-long vacation (bringing their 3-month average down from 90% to ~67%)
 * still earns partial credit rather than nothing.
 */
function uptimeRewardFactor(uptimePct: number): number {
  const FLOOR = 50;
  const CEIL = 80;
  if (uptimePct < FLOOR) return 0;
  if (uptimePct >= CEIL) return 1;
  return (uptimePct - FLOOR) / (CEIL - FLOOR);
}

/**
 * Snapshot reward calculation.
 * Should be called once per hour (or configurable period) by the BullMQ job.
 *
 * Formula per node per period:
 *   credits = pledgedGb × (period_hours/24) × tier_multiplier × uptimeRewardFactor(avg3m)
 *
 * The uptime used is the 3-month rolling average (uptimePct3m).
 * For nodes with no historical snapshots yet, the current 7-day uptimePct is used
 * as a reasonable stand-in until 3 months of data accumulates.
 */
export const rewardService = {
  async runSnapshot(): Promise<void> {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // Only count nodes that were recently online
    const activeNodes = await prisma.storageNode.findMany({
      where: { lastSeenAt: { gte: threshold } },
      select: {
        id: true,
        userId: true,
        tier: true,
        pledgedBytes: true,
        uptimePct: true,    // 7-day window, fallback for new nodes
        uptimePct3m: true,  // 3-month rolling average, null until first snapshot
      },
    });

    if (activeNodes.length === 0) return;

    // Batch-fetch 3-month average uptimePct per node in a single query
    const nodeIds = activeNodes.map((n) => n.id);
    const avgRows = await prisma.contributionSnapshot.groupBy({
      by: ["nodeId"],
      where: {
        nodeId: { in: nodeIds },
        snapshotAt: { gte: ninetyDaysAgo },
      },
      _avg: { uptimePct: true },
      _count: { id: true },
    });
    const avg3mByNode = new Map(
      avgRows.map((r) => [r.nodeId, { avg: r._avg.uptimePct ?? null, count: r._count.id }])
    );

    const PERIOD_HOURS = 1; // run every hour

    for (const node of activeNodes) {
      const history = avg3mByNode.get(node.id);
      // Use 3-month average if we have at least 24 hourly snapshots (~1 day of history).
      // This prevents a brand-new node from getting a misleadingly low average on day 1.
      const effectiveUptimePct =
        history && history.count >= 24
          ? (history.avg ?? node.uptimePct)
          : node.uptimePct;

      const factor = uptimeRewardFactor(effectiveUptimePct);
      if (factor <= 0) {
        // Still update uptimePct3m so the value stays fresh
        if (history?.avg != null) {
          await prisma.storageNode.update({
            where: { id: node.id },
            data: { uptimePct3m: history.avg },
          });
        }
        continue;
      }

      const pledgedGb = Number(node.pledgedBytes) / 1024 / 1024 / 1024;
      const multiplier = TIER_MULTIPLIER[node.tier] ?? 1.0;
      const creditsEarned =
        pledgedGb * (PERIOD_HOURS / 24) * CREDITS_PER_GB_PER_DAY * multiplier * factor;

      if (creditsEarned <= 0) continue;

      const additionalBytes = Math.floor(creditsEarned * BYTES_PER_CREDIT);
      const newUptimePct3m = history?.avg ?? node.uptimePct;

      await prisma.$transaction([
        // Record this period's snapshot (uses current 7-day uptimePct for the record)
        prisma.contributionSnapshot.create({
          data: {
            nodeId: node.id,
            userId: node.userId,
            tier: node.tier,
            pledgedBytes: node.pledgedBytes,
            uptimePct: effectiveUptimePct,
            creditsEarned,
          },
        }),

        // Update rolling 3-month average on the node
        prisma.storageNode.update({
          where: { id: node.id },
          data: { uptimePct3m: newUptimePct3m },
        }),

        // Credit the user
        prisma.rewardBalance.upsert({
          where: { userId: node.userId },
          create: {
            userId: node.userId,
            credits: creditsEarned,
            lifetimeEarned: creditsEarned,
          },
          update: {
            credits: { increment: creditsEarned },
            lifetimeEarned: { increment: creditsEarned },
          },
        }),

        // Grow storage quota
        prisma.user.update({
          where: { id: node.userId },
          data: { storageQuotaBytes: { increment: BigInt(additionalBytes) } },
        }),
      ]);
    }
  },

  /**
   * Update the 7-day rolling uptime percentage for a node.
   * Called by the auto-tier cron (index.ts) so tier assignment stays responsive.
   * Rewards use uptimePct3m; tier uses uptimePct (7-day).
   */
  async updateUptimePct(nodeId: string): Promise<void> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [total, online] = await Promise.all([
      prisma.contributionSnapshot.count({
        where: { nodeId, snapshotAt: { gte: sevenDaysAgo } },
      }),
      prisma.contributionSnapshot.count({
        where: { nodeId, snapshotAt: { gte: sevenDaysAgo }, uptimePct: { gt: 0 } },
      }),
    ]);

    const uptimePct = total > 0 ? (online / total) * 100 : 0;
    await prisma.storageNode.update({
      where: { id: nodeId },
      data: { uptimePct },
    });
  },
};


