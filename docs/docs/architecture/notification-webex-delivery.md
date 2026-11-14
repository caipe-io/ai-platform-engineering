# Webex Delivery

- Personal Webex delivery uses the existing authenticated bot administration API and the signed-in user's verified linked destination. Apps cannot supply a room or channel.
- Set `NOTIFICATION_WEBEX_ENABLED=true` only after bot configuration; users must explicitly enable this channel.
- Delivery has independent retries. Provider acceptance is not a read receipt; uncertain send outcomes remain at least once.
