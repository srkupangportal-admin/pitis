# Windows 11 LAN HTTPS Deployment

## Goal

Run the portal on a Windows 11 laptop server over HTTPS inside a LAN, using a private certificate that works for:

- Windows laptops
- Raspberry Pi kiosk browsers
- Android phones/tablets
- iPhone/iPad Safari

No router DNS changes and no public certificate authority are required.

## 1. Pick the LAN address

1. Give the Windows 11 laptop a static LAN IP.
2. Decide whether users will connect by:
   - Static IP only, for example `https://192.168.1.50:3443`
   - Static IP plus a manual hostname, for example `https://school-portal.local:3443`

If you want the hostname, add it with a `hosts` file on each client device. This avoids router DNS changes.

Windows `hosts` example:

```text
192.168.1.50 school-portal.local
```

## 2. Generate a private LAN certificate

Use an internal CA or a local CA generated with OpenSSL. Keep these files outside the repo, for example:

```text
C:\certs\school-portal\
  ca.crt
  ca.key
  server.crt
  server.key
```

Create `san.cnf`:

```ini
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = req_ext

[dn]
C = BN
ST = Brunei-Muara
L = Bandar Seri Begawan
O = School Portal
OU = LAN
CN = school-portal.local

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = school-portal.local
IP.1 = 192.168.1.50
```

Generate a root CA:

```powershell
openssl genrsa -out C:\certs\school-portal\ca.key 4096
openssl req -x509 -new -nodes -key C:\certs\school-portal\ca.key -sha256 -days 3650 -out C:\certs\school-portal\ca.crt -subj "/C=BN/ST=Brunei-Muara/L=Bandar Seri Begawan/O=School Portal/OU=LAN/CN=School Portal Root CA"
```

Generate the server key and CSR:

```powershell
openssl genrsa -out C:\certs\school-portal\server.key 2048
openssl req -new -key C:\certs\school-portal\server.key -out C:\certs\school-portal\server.csr -config san.cnf
```

Sign the server certificate with the local CA:

```powershell
openssl x509 -req -in C:\certs\school-portal\server.csr -CA C:\certs\school-portal\ca.crt -CAkey C:\certs\school-portal\ca.key -CAcreateserial -out C:\certs\school-portal\server.crt -days 825 -sha256 -extensions req_ext -extfile san.cnf
```

Notes:

- Add every LAN hostname or IP you plan to use into the SAN list before issuing the certificate.
- Reissue the server certificate if the static IP changes.

## 3. Trust the private root CA on each device

Install `ca.crt` as a trusted root on every device that will open the HTTPS portal.

### Windows

1. Open `mmc`.
2. Add the `Certificates` snap-in for `Computer account`.
3. Import `ca.crt` into `Trusted Root Certification Authorities`.

### Raspberry Pi

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/school-portal-ca.crt
sudo update-ca-certificates
```

### Android

1. Copy `ca.crt` to the device.
2. Install it from Security settings as a CA certificate.
3. Chrome may show user-installed CA warnings on some managed devices; test on the target browser.

### iPhone / iPad

1. Send `ca.crt` to the device.
2. Install the profile.
3. Go to `Settings > General > About > Certificate Trust Settings`.
4. Enable full trust for the installed root CA.

## 4. Configure `.env`

Copy `.env.example` to `.env` and update it:

```ini
HOST=0.0.0.0
HTTP_PORT=3000
HTTPS_PORT=3443
HTTPS_ENABLED=true
REDIRECT_HTTP_TO_HTTPS=true
PUBLIC_IP=192.168.1.50
PUBLIC_HOSTNAME=school-portal.local
SSL_KEY_PATH=C:\certs\school-portal\server.key
SSL_CERT_PATH=C:\certs\school-portal\server.crt
SSL_CA_PATH=C:\certs\school-portal\ca.crt
SESSION_SECRET=replace-this-with-a-long-random-secret
SECURE_COOKIES=true
TRUST_PROXY=false
```

## 5. Start the portal

```powershell
npm start
```

Expected access patterns:

- HTTPS app: `https://192.168.1.50:3443`
- Optional hostname: `https://school-portal.local:3443`
- HTTP redirect: `http://192.168.1.50:3000`

## 6. Windows firewall

Allow inbound TCP on the ports you configured, usually:

- `3000` for HTTP redirect
- `3443` for HTTPS

## 7. QR scanner behavior

For the camera scanner to work reliably:

- Always open the kiosk over HTTPS on phones and tablets.
- Trust the local root CA on the device first.
- Prefer the HTTPS IP or HTTPS hostname, not `localhost`, when scanning from other devices.
- Use the manual QR input on the kiosk page if camera permission fails or the browser blocks access.

## 8. Testing checklist

### Windows 11 laptop

1. Open `http://<ip>:3000` and confirm it redirects to HTTPS.
2. Open `https://<ip>:3443` and confirm no certificate warning after CA trust.
3. Log in and verify session persistence.
4. Open kiosk and verify camera prompt appears.
5. Scan a real student QR and confirm attendance + points flow.
6. Test manual QR input with a copied QR payload.

### Raspberry Pi kiosk

1. Open the HTTPS kiosk URL in Chromium.
2. Confirm camera permission is granted and remembered.
3. Confirm the back/USB camera is selected correctly.
4. Scan multiple student QR codes.
5. Confirm duplicate same-session scans are rejected cleanly.

### Android

1. Open the HTTPS kiosk URL in Chrome.
2. Confirm no mixed-content warnings.
3. Confirm the back camera opens by default.
4. Scan a QR in portrait and landscape.
5. Deny camera permission once and confirm the error/help text is clear.
6. Use manual QR input and confirm it still works.

### iPhone / iPad Safari

1. Open the HTTPS kiosk URL in Safari.
2. Confirm the CA is trusted and no certificate warning appears.
3. Confirm camera permission prompt appears.
4. Confirm the rear camera is preferred.
5. Scan a QR and verify attendance is recorded.
6. Confirm manual QR input works when camera access is denied.

### Portal regression

1. Home page, login, teacher dashboard, rewards, leaderboard, notes, devices, and admin pages still load over HTTPS.
2. File uploads still work over HTTPS.
3. No requests use `http://` in DevTools.
4. No API calls assume `localhost`.
5. Session cookies are present and marked `Secure` when HTTPS is enabled.
