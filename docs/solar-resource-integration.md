# Automatic bill-address solar resource

Importing and saving the bill/NEM12 evidence pair triggers a Python-only lookup:
bill site address → Geoapify Australian building match → PVGIS 5.3 PVcalc / ERA5.
Bill review also refreshes this enrichment. Raw bill and NEM12 values remain unchanged.

## API setup

PVGIS requires no API key. Register your own account at
https://myprojects.geoapify.com/, create an E3 C&I Analyzer project, then open API Keys.
Keep the key on the backend; never use a VITE_ variable or commit it. Account
registration, email verification and acceptance of provider terms are owner actions.

Local PowerShell, before launching/restarting the Python API:

```powershell
$geoapifySecret = Read-Host 'Geoapify API key' -MaskInput
$env:GEOAPIFY_API_KEY = $geoapifySecret
Remove-Variable geoapifySecret
.venv/Scripts/python.exe -m uvicorn api.ci_main:app --host 127.0.0.1 --port 18080
```

Use the existing local launch configuration for database and other settings. An
existing API process must be restarted with the new variable; simply editing
`.env.example` does not configure it. Do not start a duplicate server on that port.

Cloudflare: use `pnpm exec wrangler secret put GEOAPIFY_API_KEY` (interactive hidden
prompt), or Workers → e3-ci-web → Settings → Variables and Secrets → Add → Secret.
The Worker forwards it to the Python container. Deploy the changed Worker/container
and ensure a fresh container process starts after adding/changing the secret.
Do not expose it in client requests or screenshots. Existing projects can use
**Solution Generator → Refresh & apply PVGIS** without re-uploading files.

## Model and boundaries

- Fallback is **1000 kWh/kWp/year**, explicitly an assumption, not a provider result.
- PVGIS models **1 kWp**, crystalline silicon, free-mounted, terrain horizon enabled,
  default north-facing (app azimuth 0°, PVGIS aspect −180°), tilt 20°, `loss=0`.
- Its annual `E_y` **replaces** 1000. It is not multiplied by 1000. Array annual
  energy before clipping = capacity kWp × specific yield × additional site derating.
- PVGIS includes temperature and incidence effects even with `loss=0`. Applying a
  result sets additional temperature loss to zero. Shading, soiling, wiring,
  availability and clipping still follow the existing model; these remain editable.
- Annual/monthly numbers are climate-based expected generation, not measurements.
  The dispatch interval shape uses existing solar geometry, not PVGIS hourly weather.
  Monthly PVGIS values are reference-only in this version. Nearby buildings/trees,
  roof geometry and local shading require site assessment.
- Coordinates require user confirmation before generation. Ambiguous, low-confidence
  or non-building address results never silently become site coordinates.
- Changing orientation requires refresh before using a PVGIS-labelled yield. Manual
  overrides should be relabelled as analyst assumptions. Applying a refresh replaces
  resource fields only; saved solutions remain unchanged until regenerated.
- Resource metadata is saved with the project evidence. Current successful snapshots
  are reused for 30 days for the same address and geometry; orientation changes reuse
  coordinates but rerun PVGIS. No global customer-address cache. Provider errors,
  missing key and invalid results fall back without losing the uploaded evidence.
- Only the site address goes to Geoapify; only coordinates and model settings go to
  PVGIS. No PDF, NMI, usage records or tariff prices go to either service. These
  estimates never approve customer-dollar, demand-charge or recommendation claims.

References: https://apidocs.geoapify.com/docs/geocoding/ and
https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/using-pvgis-5/api-non-interactive-service_en
