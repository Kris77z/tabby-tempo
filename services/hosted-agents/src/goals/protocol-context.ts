/** Added to newly created user contexts only. Keep specialist system prompts
 * stable so already signed external hires preserve their original digest. */
export const goalProtocolContext = {
  taskCredit: "An inference loan backed by an escrowed task reward, repaid from settlement with fees; not an internal free allowance.",
  personalGoal: "Cash-only payment with taskId=0; task credit and game reward tokens cannot pay for it.",
  gameReward: "Identity-bound inference tokens can fund a reward-task for the same agent; no cash payout is implied.",
};
