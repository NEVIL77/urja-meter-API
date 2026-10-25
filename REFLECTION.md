# Reflection

## What assumptions did I make?

- I assumed that the time in every API response is in Indian Standard Time (IST).
- The APIs do not clearly say whether the time is server time (Zulu, UTC+0) or IST, so I cannot be sure.
- The difference between the two is 5 hours 30 minutes, so a wrong assumption would show readings at the wrong time. A reading would be believed to belong to time `t` when it actually belongs to another time.
- Example: when it is 12:00 AM (00:00) Zulu time, it is 5:30 AM IST in Jaipur on the same day.
- The full list of assumptions is in the [README](./README.md#assumptions).

## If I had another day, what would I improve?

- I would think about how to make the web app more meaningful with the same data, and how to optimize the data to get better metrics in different ways.
- If I had data from the smart meters, zone-wise and substation-wise, I could build statistics that show:
  - where theft or loss happens,
  - which areas need more load,
  - at what time periods energy consumption is high.
- This could become a dashboard for the power station that supplies the power, for better management.
- I would build a Progressive Web App (PWA) that caches API responses with a service worker. This reduces redundant network requests, improves performance and gives faster access to data.

## Which part was the most difficult, and how did I get unstuck?

- The most difficult part was the export API. It needs a signed request (an HMAC signature using the secret from `/portal/keys`), and it ignores pagination.

## What mistake did I make?

- I assumed the portal time was in IST without any proof. The portal never confirms its time zone, so a wrong assumption would show readings at the wrong time.

## What would I criticise if I reviewed my own submission?

- There is no authentication on the API.
- It uses an in-memory snapshot, so it will not scale past a few thousand meters.
- The IST assumption is not verified.