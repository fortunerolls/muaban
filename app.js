/* =====================================================================================
   muaban.vin — app.js  (đồng bộ hợp đồng MuabanVND)
   - Giá sản phẩm lưu theo VND (integer, đã gồm thuế & ship)
   - Thanh toán bằng VIN theo tỷ giá VIN/VND tại thời điểm mua
   - Người dùng phải đăng ký (payRegistration, phí 0.001 VIN) trước khi đăng/mua
   - Thông tin giao hàng của buyer được MÃ HOÁ (demo: base64 JSON) lưu on-chain
   - Escrow VIN: buyer xác nhận -> tiền về người bán; nếu quá hạn -> buyer hoàn tiền
   - Sử dụng ethers v5 (UMD) và ABI nằm ở ./abi/
   ===================================================================================== */

/* -----------------------------------------------------------------------------
   1) CẤU HÌNH & BIẾN TOÀN CỤC
----------------------------------------------------------------------------- */
const CONFIG = {
  CHAIN_ID: 88, // Viction
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://scan.viction.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR: "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
};

let providerRO, providerRW, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

// Tỷ giá & chuyển đổi
let usdtVND = null;      // 1 USDT = ? VND (CoinGecko)
let vicUSDT = null;      // 1 VIC  = ? USDT (Binance)
let vinVND  = null;      // 1 VIN  = ? VND (floor)
let vinPerVNDWei = null; // VIN wei cho 1 VND (BigNumber)

// Helpers DOM
const $  = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);
const show = (el) => el && el.removeAttribute("hidden");
const hide = (el) => el && el.setAttribute("hidden", "");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const esc = (s) =>
  (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtVND = (n) => Number(n || 0).toLocaleString("vi-VN");

/* -----------------------------------------------------------------------------
   2) KHỞI TẠO CHẾ ĐỘ ĐỌC (không cần ví) + TẢI ABI + TỶ GIÁ + DANH SÁCH
----------------------------------------------------------------------------- */
(async function boot() {
  bindUI();                      // gắn các sự kiện UI
  await loadABIs();              // nạp ABI
  initReadOnly();                // provider chỉ đọc
  await refreshRates();          // tính 1 VIN = ? VND & vinPerVNDWei
  await renderProducts();        // hiển thị danh sách sản phẩm
  refreshButtons();              // đảm bảo ẩn/hiện đúng nút khi CHƯA kết nối
})();

/* -----------------------------------------------------------------------------
   3) TẢI ABI & PROVIDER
----------------------------------------------------------------------------- */
async function loadABIs() {
  // lấy ABI từ thư mục abi (bạn đã xuất ra bằng jq)
  MUABAN_ABI = await fetch("./abi/Muaban_ABI.json").then((r) => r.json());
  VIN_ABI = await fetch("./abi/VinToken_ABI.json").then((r) => r.json());
}

function initReadOnly() {
  providerRO = new ethers.providers.JsonRpcProvider(CONFIG.RPC_URL);
  muaban = new ethers.Contract(CONFIG.MUABAN_ADDR, MUABAN_ABI, providerRO);
  vin = new ethers.Contract(CONFIG.VIN_ADDR, VIN_ABI, providerRO);
}

/* -----------------------------------------------------------------------------
   4) KẾT NỐI VÍ + KIỂM TRA ĐĂNG KÝ + SỐ DƯ
----------------------------------------------------------------------------- */
async function connectWallet() {
  if (!window.ethereum) return alert("Vui lòng cài ví EVM (MetaMask/OKX/Rabby…).");

  // Kết nối tài khoản
  providerRW = new ethers.providers.Web3Provider(window.ethereum);
  await providerRW.send("eth_requestAccounts", []);
  signer = providerRW.getSigner();
  account = await signer.getAddress();

  // Đảm bảo chain đúng
  const net = await providerRW.getNetwork();
  if (Number(net.chainId) !== CONFIG.CHAIN_ID) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CONFIG.CHAIN_ID.toString(16) }],
      });
    } catch (e) {
      return alert("Hãy chuyển sang mạng Viction (chainId 88) trong ví của bạn.");
    }
  }

  // Rebind contract sang signer (ghi)
  muaban = muaban.connect(signer);
  vin = vin.connect(signer);

  // Cập nhật UI
  $("#btn-connect").textContent = "Đã kết nối";
  $("#addr-short").textContent = short(account);
  show($("#balances"));
  await refreshBalances();
  await refreshRegistration();
  refreshButtons();      // hiện/ẩn các nút theo trạng thái đăng ký

  // Lắng nghe đổi account/chain -> reload
  if (!window._muaban_hooks) {
    window._muaban_hooks = true;
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());
  }
}

async function refreshBalances() {
  if (!account || !providerRW) return;
  const balVIN = await vin.balanceOf(account);
  const balVIC = await providerRW.getBalance(account);
  $("#bal-vin").textContent = Number(ethers.utils.formatUnits(balVIN, 18)).toFixed(4);
  $("#bal-vic").textContent = Number(ethers.utils.formatEther(balVIC)).toFixed(4);
}

async function refreshRegistration() {
  if (!account) return;
  try {
    const reg = await muaban.registered(account);
    if (reg) {
      hide($("#btn-register"));
      show($("#btn-create"));
      show($("#btn-buyer-orders"));
      show($("#btn-seller-orders"));
    } else {
      show($("#btn-register"));
      hide($("#btn-create"));
      hide($("#btn-buyer-orders"));
      hide($("#btn-seller-orders"));
    }
  } catch (e) {
    console.warn("refreshRegistration error", e);
  }
}

function refreshButtons() {
  if (!account) {
    // CHƯA kết nối -> ẩn hết trừ nút connect
    hide($("#balances"));
    hide($("#btn-register"));
    hide($("#btn-create"));
    hide($("#btn-buyer-orders"));
    hide($("#btn-seller-orders"));
  }
}

/* -----------------------------------------------------------------------------
   5) ĐĂNG KÝ (0.001 VIN): approve + payRegistration()
----------------------------------------------------------------------------- */
async function openRegister() {
  $("#register-msg").textContent = "";
  $("#dlg-register").showModal();
}

async function doRegister() {
  try {
    // lấy REG_FEE trực tiếp từ contract (public constant auto-getter)
    const fee = await muaban.REG_FEE();
    // approve
    const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, fee);
    $("#register-msg").textContent = "Đang duyệt VIN…";
    await tx1.wait();
    // pay
    const tx2 = await muaban.payRegistration();
    $("#register-msg").textContent = "Đang thanh toán 0.001 VIN…";
    await tx2.wait();
    $("#register-msg").textContent = "Đăng ký thành công!";
    $("#dlg-register").close();
    await refreshRegistration();
  } catch (e) {
    console.error(e);
    $("#register-msg").textContent = "Lỗi đăng ký: " + (e?.message || e);
  }
}

/* -----------------------------------------------------------------------------
   6) TỶ GIÁ: Lấy usdtVND (CoinGecko) & vicUSDT (Binance) → vinVND & vinPerVNDWei
   - VIN = 100 VIC  (quy ước hệ thống)
   - vinVND  = floor( vicUSDT * 100 * usdtVND )
   - vinPerVNDWei = (vicUSDT * 100 * 1e18) / usdtVND
----------------------------------------------------------------------------- */
async function refreshRates() {
  try {
    const gecko = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd")
      .then((r) => r.json());
    usdtVND = Number(gecko?.tether?.vnd || 0);

    const bin = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT")
      .then((r) => r.json());
    vicUSDT = Number(bin?.price || 0);

    if (!usdtVND || !vicUSDT) throw new Error("Không lấy được tỷ giá.");

    vinVND = Math.floor(vicUSDT * 100 * usdtVND);

    // VIN wei per 1 USD = (vicUSDT * 100) * 1e18
    const vinPerUSDWei = ethers.utils.parseUnits((vicUSDT * 100).toString(), 18);
    // VIN wei per 1 VND = vinPerUSDWei / usdtVND  (làm tròn xuống)
    vinPerVNDWei = vinPerUSDWei.div(ethers.BigNumber.from(Math.round(usdtVND).toString()));

    $("#vin-vnd").textContent = `1 VIN = ${fmtVND(vinVND)} VND`;
  } catch (e) {
    console.warn("refreshRates error", e);
    $("#vin-vnd").textContent = "1 VIN = … VND";
    vinPerVNDWei = null;
  }
}

/* -----------------------------------------------------------------------------
   7) DANH SÁCH SẢN PHẨM: quét log ProductCreated → getProduct(id) → hiển thị
   - Có ô tìm kiếm (lọc client-side theo tên)
----------------------------------------------------------------------------- */
async function renderProducts() {
  const list = $("#list");
  const empty = $("#empty");
  list.innerHTML = "";
  empty.textContent = "Đang tải sản phẩm…";
  try {
    const filter = muaban.filters.ProductCreated();
    const logs = await providerRO.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: "latest",
    });
    const ids = [...new Set(logs.map((l) => muaban.interface.parseLog(l).args.productId.toString()))];
    if (ids.length === 0) {
      empty.textContent = "Chưa có sản phẩm nào.";
      return;
    }
    empty.textContent = "";
    for (const id of ids) {
      const p = await muaban.getProduct(id);
      drawProductCard(p);
    }
  } catch (e) {
    console.warn("renderProducts error", e);
    empty.textContent = "Không tải được danh sách sản phẩm.";
  }
}

function drawProductCard(p) {
  const id = p.productId.toString();
  const name = p.name;
  const price = Number(p.priceVND.toString());
  const active = Boolean(p.active);
  const seller = (p.seller || "").toLowerCase();
  const mine = account && seller === account.toLowerCase();
  const status = active ? "Còn hàng" : "Tắt bán";
  const isVideo = (p.imageCID || "").match(/\.(mp4|webm)$/i);

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `
    ${isVideo
      ? `<video src="${esc(p.imageCID)}" controls style="width:100%;height:180px;object-fit:cover"></video>`
      : `<img src="${esc(p.imageCID)}" alt="image">`}
    <div class="card-body">
      <div class="card-title">${esc(name)} <span class="muted mono">#${id}</span></div>
      <div class="muted mono" style="word-break:break-all">${esc(p.imageCID)}</div>
      <div class="card-price">${fmtVND(price)} VND</div>
      <div class="card-meta">${status} • giao tối đa ${p.deliveryDaysMax} ngày</div>
      <div class="row" style="gap:.4rem;margin-top:.4rem">
        ${renderCardButtons({ mine, active, id, price })}
      </div>
    </div>
  `;
  $("#list").appendChild(card);
  attachCardEvents(card, { mine, active, id, price });
}

function renderCardButtons({ mine, active, id }) {
  if (!account) return ""; // chưa kết nối -> không hiện nút tác vụ
  if (mine) {
    return `
      <button class="btn ghost" data-act="update" data-id="${id}">Cập nhật</button>
      <button class="btn" data-act="toggle" data-id="${id}">${active ? "Tắt bán" : "Bật bán"}</button>`;
  } else {
    return active ? `<button class="btn secondary" data-act="buy" data-id="${id}">Mua</button>` : ``;
  }
}

function attachCardEvents(card, ctx) {
  const bUpdate = card.querySelector('[data-act="update"]');
  const bToggle = card.querySelector('[data-act="toggle"]');
  const bBuy    = card.querySelector('[data-act="buy"]');

  if (bUpdate) bUpdate.addEventListener("click", () => openUpdate(ctx.id));
  if (bToggle) bToggle.addEventListener("click", () => toggleProduct(ctx.id, !ctx.active));
  if (bBuy)    bBuy.addEventListener("click",  () => openBuy(ctx.id, ctx.price));
}

/* Tìm kiếm client-side theo tên */
function searchProducts() {
  const q = ($("#q")?.value || "").toLowerCase().trim();
  $$("#list .card").forEach((card) => {
    const title = (card.querySelector(".card-title")?.textContent || "").toLowerCase();
    card.style.display = title.includes(q) ? "" : "none";
  });
}

/* -----------------------------------------------------------------------------
   8) ĐĂNG & CẬP NHẬT SẢN PHẨM
----------------------------------------------------------------------------- */
function openCreate() {
  if (!account) return alert("Hãy kết nối ví trước.");
  $("#create-msg").textContent = "";
  $("#form-create").reset();
  $("#dlg-create").showModal();
}

async function submitCreate(ev) {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const name = fd.get("name") + (fd.get("unit") ? " / " + fd.get("unit") : "");
    const imageCID = fd.get("imageCID");
    const priceVND = Number(fd.get("priceVND"));
    const payoutWallet = fd.get("payoutWallet");
    const days = Number(fd.get("deliveryDaysMax"));

    // yêu cầu đã đăng ký
    const reg = await muaban.registered(account);
    if (!reg) return alert("Bạn cần đăng ký trước khi đăng sản phẩm.");

    const tx = await muaban.createProduct(
      name,
      "",               // descriptionCID (tuỳ bạn mở rộng)
      imageCID,
      priceVND,
      days,
      payoutWallet,
      true              // active
    );
    $("#create-msg").textContent = "Đang gửi giao dịch…";
    await tx.wait();
    $("#dlg-create").close();
    await renderProducts();
    alert("Đăng sản phẩm thành công!");
  } catch (e) {
    console.error(e);
    $("#create-msg").textContent = "Lỗi: " + (e?.message || e);
  }
}

async function openUpdate(productId) {
  if (!account) return alert("Hãy kết nối ví.");
  $("#update-msg").textContent = "";
  $("#form-update").reset();

  const p = await muaban.getProduct(productId);
  if (p.seller.toLowerCase() !== account.toLowerCase()) return alert("Bạn không phải người bán sản phẩm này.");

  $("#form-update [name=productId]").value = productId;
  $("#form-update [name=priceVND]").value = Number(p.priceVND.toString());
  $("#form-update [name=deliveryDaysMax]").value = Number(p.deliveryDaysMax.toString());
  $("#form-update [name=payoutWallet]").value = p.payoutWallet;
  $("#form-update [name=active]").value = p.active ? "true" : "false";
  $("#dlg-update").showModal();
}

async function submitUpdate(ev) {
  ev.preventDefault();
  try {
    const fd = new FormData(ev.target);
    const pid = fd.get("productId");
    const priceVND = Number(fd.get("priceVND"));
    const days = Number(fd.get("deliveryDaysMax"));
    const payout = fd.get("payoutWallet");
    const active = fd.get("active") === "true";

    const tx = await muaban.updateProduct(pid, priceVND, days, payout, active);
    $("#update-msg").textContent = "Đang gửi giao dịch…";
    await tx.wait();
    $("#dlg-update").close();
    await renderProducts();
    alert("Cập nhật thành công!");
  } catch (e) {
    console.error(e);
    $("#update-msg").textContent = "Lỗi: " + (e?.message || e);
  }
}

async function toggleProduct(pid, toActive) {
  try {
    const tx = await muaban.setProductActive(pid, toActive);
    await tx.wait();
    await renderProducts();
  } catch (e) {
    console.error(e);
    alert("Không đổi được trạng thái bán.");
  }
}

/* -----------------------------------------------------------------------------
   9) MUA HÀNG (mã hoá buyer info) + TÍNH VIN CHÍNH XÁC
   - vinPerVNDWei đã tính từ refreshRates()
   - tổng VIN wei = priceVND * quantity * vinPerVNDWei  (ceil → ở đây perVNDWei đã là wei, không cần chia)
----------------------------------------------------------------------------- */
function openBuy(productId, priceVND) {
  if (!account) return alert("Hãy kết nối ví.");
  $("#buy-msg").textContent = "";
  $("#form-buy").reset();
  $("#form-buy [name=productId]").value = productId;
  $("#dlg-buy").showModal();

  const qtyInput = $("#buy-qty");
  const totalEl = $("#buy-total-vin");

  const renderTotal = async () => {
    if (!vinPerVNDWei) await refreshRates();
    const qty = Math.max(1, Number(qtyInput.value || 1));
    const wei = ethers.BigNumber.from(priceVND.toString())
      .mul(ethers.BigNumber.from(qty.toString()))
      .mul(ethers.BigNumber.from(vinPerVNDWei.toString()));
    totalEl.textContent = ethers.utils.formatUnits(wei, 18); // hiển thị VIN
  };
  qtyInput.addEventListener("input", renderTotal);
  renderTotal();
}

async function submitBuy(ev) {
  ev.preventDefault();
  try {
    if (!vinPerVNDWei) await refreshRates();

    const fd = new FormData(ev.target);
    const pid = fd.get("productId");
    const qty = Math.max(1, Number(fd.get("quantity") || 1));

    // Lấy product để tính chính xác (tránh người dùng sửa giá phía client)
    const p = await muaban.getProduct(pid);
    if (!p.active) return alert("Sản phẩm đang tắt bán.");

    // Ước lượng VIN wei
    const needWei = ethers.BigNumber.from(p.priceVND.toString())
      .mul(ethers.BigNumber.from(qty.toString()))
      .mul(ethers.BigNumber.from(vinPerVNDWei.toString()));

    // Chuẩn bị ciphertext (DEMO: base64 JSON — nên thay bằng AES thực tế)
    const info = {
      fullName: fd.get("fullName"),
      phone: fd.get("phone"),
      address: fd.get("address"),
      note: fd.get("note"),
    };
    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    // Approve đủ số VIN (thêm đệm 1% để tránh chênh lệch)

    const allowance = await vin.allowance(account, CONFIG.MUABAN_ADDR);
    const needPlus = needWei.mul(101).div(100); // +1%
    if (allowance.lt(needPlus)) {
      const tx1 = await vin.approve(CONFIG.MUABAN_ADDR, needPlus);
      $("#buy-msg").textContent = "Đang duyệt VIN…";
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx2 = await muaban.placeOrder(
      pid,
      qty,
      vinPerVNDWei.toString(),
      cipher
    );
    $("#buy-msg").textContent = "Đang gửi đơn hàng…";
    await tx2.wait();

    $("#buy-msg").textContent = "Đặt hàng thành công!";
    $("#dlg-buy").close();
    await listBuyerOrders(); // làm mới ngay bảng đơn mua nếu đang mở
  } catch (e) {
    console.error(e);
    $("#buy-msg").textContent = "Lỗi: " + (e?.message || e);
  }
}

/* -----------------------------------------------------------------------------
   10) ĐƠN HÀNG — Buyer & Seller
   - Buyer: lọc event OrderPlaced theo buyer = account (indexed)
   - Seller: quét tất cả OrderPlaced, lấy order.productId -> getProduct -> so sánh seller
----------------------------------------------------------------------------- */
async function listBuyerOrders() {
  if (!account) return;
  const body = $("#buyer-orders-body");
  body.innerHTML = "<tr><td colspan='7'>Đang tải…</td></tr>";
  try {
    const filter = muaban.filters.OrderPlaced(null, null, account);
    const logs = await providerRO.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: "latest",
    });
    if (!logs.length) {
      body.innerHTML = "<tr><td colspan='7' class='muted'>Chưa có đơn hàng.</td></tr>";
      return;
    }
    body.innerHTML = "";
    for (const l of logs) {
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      body.appendChild(renderBuyerRow(o, p));
    }
  } catch (e) {
    console.error(e);
    body.innerHTML = "<tr><td colspan='7'>Không tải được đơn hàng.</td></tr>";
  }
}

function renderBuyerRow(o, p) {
  const tr = document.createElement("tr");
  const deadline = new Date(Number(o.deadline.toString()) * 1000).toLocaleString();
  const status = ["NONE", "PLACED", "RELEASED", "REFUNDED"][Number(o.status)];
  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount, 18)).toFixed(6)}</td>
    <td>${deadline}</td>
    <td>${status}</td>
    <td>
      ${Number(o.status) === 1 ? `
        <button class="btn ghost" data-act="confirm" data-id="${o.orderId}">Xác nhận đã nhận</button>
        <button class="btn" data-act="refund" data-id="${o.orderId}">Hoàn tiền</button>
      ` : ""}
    </td>
  `;
  tr.querySelector('[data-act="confirm"]')?.addEventListener("click", () => confirmReceipt(o.orderId.toString(), tr));
  tr.querySelector('[data-act="refund"]')?.addEventListener("click", () => refundIfExpired(o.orderId.toString(), tr));
  return tr;
}

async function listSellerOrders() {
  if (!account) return;
  const body = $("#seller-orders-body");
  body.innerHTML = "<tr><td colspan='7'>Đang tải…</td></tr>";
  try {
    const filter = muaban.filters.OrderPlaced();
    const logs = await providerRO.getLogs({
      address: CONFIG.MUABAN_ADDR,
      topics: filter.topics,
      fromBlock: 0,
      toBlock: "latest",
    });
    let any = false;
    body.innerHTML = "";
    for (const l of logs) {
      const ev = muaban.interface.parseLog(l);
      const orderId = ev.args.orderId.toString();
      const o = await muaban.getOrder(orderId);
      const p = await muaban.getProduct(o.productId.toString());
      if ((p.seller || "").toLowerCase() !== account.toLowerCase()) continue;
      any = true;
      body.appendChild(renderSellerRow(o, p));
    }
    if (!any) {
      body.innerHTML = "<tr><td colspan='7' class='muted'>Chưa có đơn hàng bán.</td></tr>";
    }
  } catch (e) {
    console.error(e);
    body.innerHTML = "<tr><td colspan='7'>Không tải được đơn hàng.</td></tr>";
  }
}

function renderSellerRow(o, p) {
  const tr = document.createElement("tr");
  const deadline = new Date(Number(o.deadline.toString()) * 1000).toLocaleString();
  const status = ["NONE", "PLACED", "RELEASED", "REFUNDED"][Number(o.status)];
  tr.innerHTML = `
    <td class="mono">#${o.orderId}</td>
    <td class="mono">${short(o.buyer)}</td>
    <td>${esc(p.name)}</td>
    <td>${o.quantity}</td>
    <td class="mono">${Number(ethers.utils.formatUnits(o.vinAmount, 18)).toFixed(6)}</td>
    <td>${deadline}</td>
    <td>${status}</td>
  `;
  return tr;
}

async function confirmReceipt(orderId, row) {
  try {
    const tx = await muaban.confirmReceipt(orderId);
    row?.querySelectorAll("button")?.forEach((b) => (b.disabled = true));
    await tx.wait();
    await listBuyerOrders();
    alert("Đã xác nhận đã nhận hàng.");
  } catch (e) {
    console.error(e);
    alert("Lỗi xác nhận: " + (e?.message || e));
  }
}

async function refundIfExpired(orderId, row) {
  try {
    const tx = await muaban.refundIfExpired(orderId);
    row?.querySelectorAll("button")?.forEach((b) => (b.disabled = true));
    await tx.wait();
    await listBuyerOrders();
    alert("Đã yêu cầu hoàn tiền (nếu quá hạn).");
  } catch (e) {
    console.error(e);
    alert("Lỗi hoàn tiền: " + (e?.message || e));
  }
}

/* -----------------------------------------------------------------------------
   11) GẮN SỰ KIỆN UI
----------------------------------------------------------------------------- */
function bindUI() {
  // Connect & Register
  $("#btn-connect")?.addEventListener("click", connectWallet);
  $("#btn-register")?.addEventListener("click", openRegister);
  $("#btn-register-confirm")?.addEventListener("click", doRegister);

  // Create / Update
  $("#btn-create")?.addEventListener("click", openCreate);
  $("#form-create")?.addEventListener("submit", submitCreate);
  $("#form-update")?.addEventListener("submit", submitUpdate);

  // Buy
  $("#form-buy")?.addEventListener("submit", submitBuy);

  // Orders dialogs
  $("#btn-buyer-orders")?.addEventListener("click", () => {
    $("#dlg-buyer-orders").showModal();
    listBuyerOrders();
  });
  $("#btn-seller-orders")?.addEventListener("click", () => {
    $("#dlg-seller-orders").showModal();
    listSellerOrders();
  });

  // Search
  $("#btn-search")?.addEventListener("click", searchProducts);
  $("#q")?.addEventListener("keyup", (e) => {
    if (e.key === "Enter") searchProducts();
  });
}
