# PrintEasy — Commercial Print Precision On Demand

A modern, high-precision web application for commercial print procurement, automated real-time preflight validation, and print production floor management.

Based on the **Print Precision** design system and the extracted **PrintEasy Web App** screen specifications.

---

## 🚀 How to Run the Website

### Option 1: Direct Browser Launch (Simplest)
You can directly double-click or open **`index.html`** in any web browser (Google Chrome, Microsoft Edge, Mozilla Firefox, Safari). No server or build step required!

### Option 2: Local Web Server (Zero-Dependency)
Right-click `start-server.ps1` and select **Run with PowerShell** (or run `powershell -ExecutionPolicy Bypass -File .\start-server.ps1`).  
It will automatically launch:
```
http://localhost:8080/
```

---

## 🌟 Key Features & Included Flows

### 1. Customer Portal
- **Step 1: Upload & Order (`#upload`)**
  - Interactive drag-and-drop dropzone supporting PDF, DOCX, JPG, PNG, AI, and TIFF files.
  - Realistic automated preflight check simulation (verifying DPI, CMYK color gamut, and bleed margins).
  - Cloud Drive integration modals (Google Drive & Dropbox).
  - Real-time Queue Tray showing queued files, page counts, payload sizes, and resolution checks.
  - Value proposition callouts (24h turnaround, 100% color accuracy, FSC eco-friendly stocks).

- **Step 2: Configure Specs (`#configure`)**
  - Multi-part commercial configuration per file:
    - **Paper Size & Dimensions**: Letter (8.5×11″), A4 (210×297mm), A3 (297×420mm), Legal, Tabloid, Photo 4×6, 5×7, 8×10, Poster 18×24.
    - **Color Mode**: Black & White ($0.08/page) vs. True CMYK Full Color ($0.35/page).
    - **Paper Finish**: Non-glare Matte, High Sheen Glossy, Satin Lustre.
    - **Substrates**: 80gsm Standard, 120gsm Premium Smooth, 250gsm Cardstock, Linen Finish.
    - **Binding & Finishing**: None, Corner Staple, Black Wire Spiral Bound, Saddle Stitch.
    - **Quantity Controls**: `[-]` / `[+]` copy counters with dynamic recalculation.
  - Interactive **Prepress Proof Modal** (with bleed line, safe margin trim guides, registration marks, and CMYK color control bars).
  - **Sticky Order Summary**:
    - Itemized subtotal breakdown.
    - Sales tax (8.0%) calculation.
    - Store pickup vs. express delivery.
    - Promo code redemption (try **`PRINT10`** for 10% off).
    - Express checkout action.

- **Step 3: Checkout & Order Tracking (`#tracking`)**
  - Order confirmation dispatch with dynamic order ID (e.g. `#PE-84920`).
  - **Live Prepress & Production Telemetry Stepper**:
    1. Order Received
    2. In Printing (with live RIP rasterization progress bar & active press name)
    3. Quality Inspection
    4. Ready for Pickup (with 4-digit locker PIN)
  - Fulfillment Mode Switcher: Downtown Hub Store Pickup (with map preview & directions) vs. Express Courier Delivery.
  - Action buttons: Add to Apple Wallet (with feedback toast), Print Receipt, and Printable Commercial Invoice modal.
  - Live chat drawer with prepress operator Alex M.

### 2. Admin Operations Console (Staff View)
- Seamless top-bar toggle: Flip between **Customer** and **Admin Ops** mode anytime!
- **Orders Queue (`#admin`)**
  - Shift Alpha production floor overview.
  - 4 Dynamic KPI metric cards: Active Jobs, Awaiting Preflight, On Press, Ready for Pickup (recalculated live from data).
  - Segmented status filters: All Jobs, New, In Printing, Ready, Completed.
  - Search query filter by Order ID, customer, file name, or specs.
  - Master Production Table with status dropdowns that update immediately.
  - Bulk actions: "Mark Selected Ready", "Batch Work Tickets", and "Export Manifest (CSV)".
  - Press equipment load monitors (Canon C10010VP & HP PageWide Plotter) and paper stock inventory level alerts.
  - "New Manual Job" ticket modal.
- **Order Detail View (`#admin-detail`)**
  - Multipage brochure prepress inspection canvas with toggleable trim guidelines and zoom magnifier.
  - Page carousel thumbnail selector (inspect individual pages).
  - Technical specifications matrix.
  - Verified customer profile and order history.
  - Internal floor notes that auto-save in real-time to `localStorage`.
  - **"Send Ready for Pickup SMS & Email"** button with interactive customer notification confirmation banner.

---

## 🎨 Design System Compliance
- **Colors**: Deep Marine Teal (`#005F73`), Vivid Sea Green (`#0A9396`), Slate Tiers (`#F8FAFC`, `#FFFFFF`, `#E2E8F0`).
- **Typography**: Plus Jakarta Sans with OpenType tabular figures (`tnum`).
- **Icons**: Google Material Symbols Outlined.
- **Logo**: Precision vector SVG logo with brand mark and typography.
