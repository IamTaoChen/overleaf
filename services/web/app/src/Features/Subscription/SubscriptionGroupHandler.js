const { callbackify } = require('util')
const SubscriptionUpdater = require('./SubscriptionUpdater')
const SubscriptionLocator = require('./SubscriptionLocator')
const SubscriptionController = require('./SubscriptionController')
const { Subscription } = require('../../models/Subscription')
const RecurlyClient = require('./RecurlyClient')
const PlansLocator = require('./PlansLocator')
const SubscriptionHandler = require('./SubscriptionHandler')
const GroupPlansData = require('./GroupPlansData')
const { MEMBERS_LIMIT_ADD_ON_CODE } = require('./RecurlyEntities')

async function removeUserFromGroup(subscriptionId, userIdToRemove) {
  await SubscriptionUpdater.promises.removeUserFromGroup(
    subscriptionId,
    userIdToRemove
  )
}

async function replaceUserReferencesInGroups(oldId, newId) {
  await Subscription.updateOne({ admin_id: oldId }, { admin_id: newId }).exec()

  await _replaceInArray(Subscription, 'manager_ids', oldId, newId)
  await _replaceInArray(Subscription, 'member_ids', oldId, newId)
}

async function isUserPartOfGroup(userId, subscriptionId) {
  const subscription =
    await SubscriptionLocator.promises.getSubscriptionByMemberIdAndId(
      userId,
      subscriptionId
    )

  return !!subscription
}

async function getTotalConfirmedUsersInGroup(subscriptionId) {
  const subscription =
    await SubscriptionLocator.promises.getSubscription(subscriptionId)

  return subscription?.member_ids?.length
}

async function _replaceInArray(model, property, oldValue, newValue) {
  // Mongo won't let us pull and addToSet in the same query, so do it in
  // two. Note we need to add first, since the query is based on the old user.
  const query = {}
  query[property] = oldValue

  const setNewValue = {}
  setNewValue[property] = newValue

  const setOldValue = {}
  setOldValue[property] = oldValue

  await model.updateMany(query, { $addToSet: setNewValue })
  await model.updateMany(query, { $pull: setOldValue })
}

async function ensureFlexibleLicensingEnabled(plan) {
  if (!plan?.canUseFlexibleLicensing) {
    throw new Error('The group plan does not support flexible licensing')
  }
}

async function ensureSubscriptionIsActive(subscription) {
  if (subscription?.recurlyStatus?.state !== 'active') {
    throw new Error('The subscription is not active')
  }
}

async function getUsersGroupSubscriptionDetails(userId) {
  const subscription =
    await SubscriptionLocator.promises.getUsersSubscription(userId)

  if (!subscription) {
    throw new Error('No subscription was found')
  }

  if (!subscription.groupPlan) {
    throw new Error('User subscription is not a group plan')
  }

  const plan = PlansLocator.findLocalPlanInSettings(subscription.planCode)

  const recurlySubscription = await RecurlyClient.promises.getSubscription(
    subscription.recurlySubscription_id
  )

  return {
    userId,
    subscription,
    recurlySubscription,
    plan,
  }
}

async function _addSeatsSubscriptionChange(userId, adding) {
  const { subscription, recurlySubscription, plan } =
    await getUsersGroupSubscriptionDetails(userId)
  await ensureFlexibleLicensingEnabled(plan)
  await ensureSubscriptionIsActive(subscription)
  const currentAddonQuantity =
    recurlySubscription.addOns.find(
      addOn => addOn.code === MEMBERS_LIMIT_ADD_ON_CODE
    )?.quantity ?? 0
  // Keeps only the new total quantity of addon
  const nextAddonQuantity = currentAddonQuantity + adding

  let changeRequest
  if (recurlySubscription.hasAddOn(MEMBERS_LIMIT_ADD_ON_CODE)) {
    // Not providing a custom price as once the subscription is locked
    // to an add-on at a given price, it will use it for subsequent payments
    changeRequest = recurlySubscription.getRequestForAddOnUpdate(
      MEMBERS_LIMIT_ADD_ON_CODE,
      nextAddonQuantity
    )
  } else {
    let unitPrice
    const newPlanPricesAppliedAt = new Date('2025-01-08T14:00:00Z')
    const isLegacyPriceApplicable =
      new Date(recurlySubscription.createdAt) < newPlanPricesAppliedAt

    if (isLegacyPriceApplicable) {
      const pattern =
        /^group_(collaborator|professional)_(2|3|4|5|10|20|50)_(educational|enterprise)$/
      const [, planCode, size, usage] = plan.planCode.match(pattern)
      const currency = recurlySubscription.currency
      const legacyPriceInCents =
        GroupPlansData[usage][planCode][currency][size]
          .additional_license_legacy_price_in_cents

      if (legacyPriceInCents > 0) {
        unitPrice = legacyPriceInCents / 100
      }
    }

    changeRequest = recurlySubscription.getRequestForAddOnPurchase(
      MEMBERS_LIMIT_ADD_ON_CODE,
      nextAddonQuantity,
      unitPrice
    )
  }

  return {
    changeRequest,
    currentAddonQuantity,
    recurlySubscription,
  }
}

async function previewAddSeatsSubscriptionChange(userId, adding) {
  const { changeRequest, currentAddonQuantity } =
    await _addSeatsSubscriptionChange(userId, adding)
  const paymentMethod = await RecurlyClient.promises.getPaymentMethod(userId)
  const subscriptionChange =
    await RecurlyClient.promises.previewSubscriptionChange(changeRequest)
  const subscriptionChangePreview =
    await SubscriptionController.makeChangePreview(
      {
        type: 'add-on-update',
        addOn: {
          code: MEMBERS_LIMIT_ADD_ON_CODE,
          quantity: subscriptionChange.nextAddOns.find(
            addon => addon.code === MEMBERS_LIMIT_ADD_ON_CODE
          ).quantity,
          prevQuantity: currentAddonQuantity,
        },
      },
      subscriptionChange,
      paymentMethod
    )

  return subscriptionChangePreview
}

async function createAddSeatsSubscriptionChange(userId, adding) {
  const { changeRequest, recurlySubscription } =
    await _addSeatsSubscriptionChange(userId, adding)
  await RecurlyClient.promises.applySubscriptionChangeRequest(changeRequest)
  await SubscriptionHandler.promises.syncSubscription(
    { uuid: recurlySubscription.id },
    userId
  )

  return { adding }
}

async function _getUpgradeTargetPlanCodeMaybeThrow(subscription) {
  if (
    subscription.planCode.includes('professional') ||
    !subscription.groupPlan
  ) {
    throw new Error('Not eligible for group plan upgrade')
  }

  return subscription.planCode.replace('collaborator', 'professional')
}

async function _getGroupPlanUpgradeChangeRequest(ownerId) {
  const olSubscription =
    await SubscriptionLocator.promises.getUsersSubscription(ownerId)

  await ensureSubscriptionIsActive(olSubscription)

  const newPlanCode = await _getUpgradeTargetPlanCodeMaybeThrow(olSubscription)
  const recurlySubscription = await RecurlyClient.promises.getSubscription(
    olSubscription.recurlySubscription_id
  )

  return recurlySubscription.getRequestForGroupPlanUpgrade(newPlanCode)
}

async function getGroupPlanUpgradePreview(ownerId) {
  const changeRequest = await _getGroupPlanUpgradeChangeRequest(ownerId)
  const subscriptionChange =
    await RecurlyClient.promises.previewSubscriptionChange(changeRequest)
  const paymentMethod = await RecurlyClient.promises.getPaymentMethod(ownerId)
  return SubscriptionController.makeChangePreview(
    {
      type: 'group-plan-upgrade',
      prevPlan: {
        name: SubscriptionController.getPlanNameForDisplay(
          subscriptionChange.subscription.planName,
          subscriptionChange.subscription.planCode
        ),
      },
    },
    subscriptionChange,
    paymentMethod
  )
}

async function upgradeGroupPlan(ownerId) {
  const changeRequest = await _getGroupPlanUpgradeChangeRequest(ownerId)
  await RecurlyClient.promises.applySubscriptionChangeRequest(changeRequest)
  await SubscriptionHandler.promises.syncSubscription(
    { uuid: changeRequest.subscription.id },
    ownerId
  )
}

module.exports = {
  removeUserFromGroup: callbackify(removeUserFromGroup),
  replaceUserReferencesInGroups: callbackify(replaceUserReferencesInGroups),
  ensureFlexibleLicensingEnabled: callbackify(ensureFlexibleLicensingEnabled),
  ensureSubscriptionIsActive: callbackify(ensureSubscriptionIsActive),
  getTotalConfirmedUsersInGroup: callbackify(getTotalConfirmedUsersInGroup),
  isUserPartOfGroup: callbackify(isUserPartOfGroup),
  getGroupPlanUpgradePreview: callbackify(getGroupPlanUpgradePreview),
  upgradeGroupPlan: callbackify(upgradeGroupPlan),
  promises: {
    removeUserFromGroup,
    replaceUserReferencesInGroups,
    ensureFlexibleLicensingEnabled,
    ensureSubscriptionIsActive,
    getTotalConfirmedUsersInGroup,
    isUserPartOfGroup,
    getUsersGroupSubscriptionDetails,
    previewAddSeatsSubscriptionChange,
    createAddSeatsSubscriptionChange,
    getGroupPlanUpgradePreview,
    upgradeGroupPlan,
  },
}
