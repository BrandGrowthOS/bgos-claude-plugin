# Disposable Chromium fixture certificate trust

Sandboxed Chromium 153.0.8010.12 ran as uid 1000 in a disposable Linux container with network access limited to its own loopback interface. Only the exact temporary fixture certificate was imported into NSS under a private HOME directory. Chromium loaded that HTTPS page with status 200 and refused an independently signed certificate with `ERR_CERT_AUTHORITY_INVALID`.

The probe uses `ignoreHTTPSErrors:false`, Chromium sandboxing, and no certificate or sandbox bypass flags. Both TLS servers closed, the exact owned browser process disappeared, and successful exact Docker inventory confirmed container absence without forced cleanup. Installing certutil occurred only in the disposable image; image build package traffic is separate from the runtime network restriction. No host trust, firewall, installed agent or production state changed.

Independent review verified the actual JavaScript source hash and receipt. This qualifies the private fixture trust needed for an actual tab/cookie transfer test. It does not establish reverse transfer, imported-cookie HTTP delivery, product browser-control routing, or a user's login behavior.
