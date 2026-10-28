/**
 * Idempotent release of a reservation after an instruction is cancelled/rejected.
 * The release marker and amount decrement share one MongoDB document update,
 * so retrying after a crash cannot subtract the same reservation twice.
 */
export async function releaseInstructionReservation(db, instruction) {
  if (!instruction || instruction.reservationActive !== false || !instruction._id) {
    throw new Error('Instruction must first be transitioned to an inactive reservation.');
  }

  const instructionId = instruction._id.toString();
  const accountId = instruction.accountId.toString();
  const accountField = `accountReservedStakeMinor.${accountId}`;
  const spend = db.collection('dailySpend');
  const spendResult = await spend.updateOne({
    ownerUserId: instruction.ownerUserId,
    day: instruction.reservationDay,
    releasedInstructionIds: { $ne: instructionId },
    reservedStakeMinor: { $gte: instruction.stakeMinor },
    [accountField]: { $gte: instruction.stakeMinor }
  }, {
    $inc: { reservedStakeMinor: -instruction.stakeMinor, [accountField]: -instruction.stakeMinor },
    $addToSet: { releasedInstructionIds: instructionId },
    $set: { updatedAt: new Date() }
  });

  // If the release marker is already present, the amount decrement has already
  // happened. If no marker exists and no decrement occurred, do not silently
  // pretend the reservation was released: leave it pending for investigation.
  const spendAfter = await spend.findOne({ ownerUserId: instruction.ownerUserId, day: instruction.reservationDay });
  const alreadyReleased = (spendAfter?.releasedInstructionIds || []).includes(instructionId);
  if (spendResult.modifiedCount === 0 && !alreadyReleased) {
    throw new Error('Reservation could not be released safely; reconciliation is required.');
  }

  const policies = db.collection('safetyPolicies');
  const policyResult = await policies.updateOne({
    ownerUserId: instruction.ownerUserId,
    openInstructionCount: { $gt: 0 },
    releasedOpenSlotInstructionIds: { $ne: instructionId }
  }, {
    $inc: { openInstructionCount: -1 },
    $addToSet: { releasedOpenSlotInstructionIds: instructionId },
    $set: { updatedAt: new Date() }
  });
  const policyAfter = await policies.findOne({ ownerUserId: instruction.ownerUserId });
  const openSlotAlreadyReleased = (policyAfter?.releasedOpenSlotInstructionIds || []).includes(instructionId);
  if (policyResult.modifiedCount === 0 && !openSlotAlreadyReleased) {
    throw new Error('Open-instruction slot could not be released safely; reconciliation is required.');
  }

  await db.collection('betInstructions').updateOne({
    _id: instruction._id,
    ownerUserId: instruction.ownerUserId,
    reservationActive: false
  }, { $set: { reservationReleaseState: 'released', reservationReleasedAt: new Date(), updatedAt: new Date() } });
}

export async function recoverPendingReservationReleases(db) {
  const pending = await db.collection('betInstructions').find({
    reservationActive: false,
    reservationReleaseState: 'pending',
    status: { $in: ['cancelled', 'rejected'] }
  }).limit(500).toArray();
  const results = { checked: pending.length, released: 0, failed: 0 };
  for (const instruction of pending) {
    try {
      await releaseInstructionReservation(db, instruction);
      results.released += 1;
    } catch {
      results.failed += 1;
    }
  }
  return results;
}
