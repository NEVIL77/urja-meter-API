# What I found in the portal

## 1. Overview

- The application is made with SvelteKit: https://prnt.sc/E6HXsOT9xJVO
- Extension used: Wrapplizer
- API endpoint: `https://urja-ops.flockenergy.tech`
- All APIs are GET requests (apart from the login form).

## 2. Access and authentication

- Sign-in is a form POST to `/login` (SvelteKit form action, with the header `x-sveltekit-action: true`) using the email and password.
- On login, the portal stores the token in a cookie with a 60-minute expiry. Every later call sends that cookie.
- When the token expires, the API answers `401` with the error `unauthorized`, so the client has to sign in again.
- ⚠️ The portal rate-limits requests. Once the limit is hit it answers `429` and blocks for about a minute, without any header saying so.
- Login for the task (from the brief):

```
PORTAL_EMAIL=operator@urja.local
PORTAL_PASSWORD=urja-ops-2026
```

## 3. API list

### 3.1 `/portal/meters/search?q=&page=N`

Used to fetch the meters list. The same API is used to search meters and for pagination.

### 3.2 `/portal/meters/{id}/energy`

Used to fetch the energy data of the meter. Array of objects. Each object has:

```json
{
    "timestamp": "23/06/2026 23:30",
    "kwh": "42594.05",
    "kvah": "46001.58",
    "voltR": "231"
}
```

The timestamp does not tell which timezone this data is in — IST or Zulu timezone data (server).

### 3.3 `/portal/meters/{id}/geo`

Used to fetch the geo location of the meter. Object with lat and lon:

```json
{"latitude":"26.822136543835608","longitude":"75.90718190602279"}
```

This exact lat and long will help to pinpoint the location of the meter on the map.

### 3.4 `/portal/dts?page=N`

Used to fetch the Distribution Transformers. Array of objects. Each object has:

```json
{"capacityKva":"","code":"","feederCode":"","name":""}
```

### 3.5 `/portal/keys`

The key for signing the export. Used for the export API.

### 3.6 `/portal/export?page=N`

Used to export meters in JSON format. The request must be signed:

- Send the headers `x-timestamp` (current time in seconds) and `x-signature`.
- The signature is an HMAC-SHA256 (hex) of `GET`, the path, the query and the timestamp, joined by new lines, using the secret from `/portal/keys`.

## 4. Network hierarchy

### 4.1 The 7 levels (from top to bottom)

1. Zone → (Like: Jaipur Zone 1) - Main area  
   └── 2. Circle → (Like: Circle 1)  
       └── 3. Division → (Like: Division 1)  
           └── 4. Subdivision → (Like: Malviya Nagar Subdivision)  
               └── 5. Substation → (Power Station)  
                   └── 6. Feeder → (Transmission line from Substation: 11kV main line)  
                       └── 7. DT → (Distribution Transformer - Gali/mohalle's transformer)  
                           └── [Meter] → (Customer's Smart Meter)

With this we can get one of the most critical things with a meter.

### 4.2 Outage and fault isolation

If a Feeder trips or fails, the system immediately knows which specific Transformers (DTs) and Meters have lost power.

### 4.3 Energy auditing and theft detection

If a Transformer (DT) delivers 1,000 kWh of energy, but the sum of all Meters connected under that DT only records 800 kWh, operators immediately know there is a 200 kWh energy loss or theft occurring on that specific transformer.

💡🔴 **IMPROVEMENT (Critical):** with the UI we can see on the map where this happens, with the help of the API.

### 4.4 Asset tracking

It tells operators the exact electrical source feeding meter J100000 without requiring physical inspection of field wiring.

💡 **IMPROVEMENT:** as we have lat and long data, we can get the direction in the new UI or Google Maps so that a newly joined employee who is not familiar with the area can get the exact location of each hierarchy point.

## 5. Quirks and bugs

### Session bug

⚠️ **BUG: session stays open after token expiry (bad UX / security gap).**

When the token expires, the API gives a 401 error, which is expected, but the web application remains as it is. It is supposed to log out and redirect to the login page, but that is not happening: https://prnt.sc/z0mHmZz_3B1X

### Export pagination bug

🚨 **BUG: export API does not respect pagination — security + performance risk.** Reference photo: https://prnt.sc/s-zdl0uPKeKD

1. **Pagination is ignored.** The API is called with pagination, but it does not respect the pagination and returns the full meters list.

2. **Load explodes at city scale.** If this API is called, it fetches all the meters and returns them in the response. Right now there are limited meters, so the response may be fast. But what if for whole Jaipur city there are **10,000+** meters? DB query time and DB load increase, server load increases, and it may cause a server-down issue.

3. **Anyone with portal access can take the server down.** If this API takes too much time and puts load on the server and database, some employee who has access to the portal can call this API on purpose to bring the server down — which results in server down and extra server cost as well.

4. **Full data dump.** Someone can dump all the meters data at once, including critical data.

5. **This is a security and performance issue.**

6. **Better export shape.** For me, this export should be meters grouped by Distribution Transformer, or zone-wise, or feeder-wise. Also role-wise export: an employee who is working in a particular zone or sub-division can export only that zone's or sub-division's meters list.

### Time zone is not stated

⚠️ **QUIRK:** the energy timestamps (`DD/MM/YYYY HH:mm`) carry no time zone, so it is unclear whether they are IST or Zulu (server time). See section 3.2.
