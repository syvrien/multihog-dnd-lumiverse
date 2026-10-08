/** A scene may use the live memo only after its chat partition is projected. */
export function canUseSceneMemo(settings, chatId, memo = settings.currentMemo) {
    if (settings.chatLinkEnabled && settings.chatStateProjectionOwner
        && String(settings.chatStateProjectionOwner) !== String(chatId)) return false;
    return (memo || '') === (settings.currentMemo || '');
}
