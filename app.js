/* ====================================================================
   muaban.vin — app.js (ethers v5)
   MỤC TIÊU: sửa lỗi "Internal JSON-RPC error" khi ký giao dịch & ổn định UI
   - ÉP GIAO DỊCH LEGACY (type 0) dùng gasPrice; KHÔNG gửi EIP-1559 trên VIC
   - Preflight mọi giao dịch (populateTransaction + provider.call({from}))
     để bắt revert rõ ràng (NOT_REGISTERED, PRICE_REQUIRED, ...)
   - Tỷ giá VIN/VND: lấy từ nhiều nguồn; có thể override qua <body data-vin-vnd>
   - Bám sát HTML (index.html) & ABI (Muaban_ABI.json, VinToken_ABI.json)
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";
const toast=(m)=>alert(m);

/* -------------------- Cấu hình -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  // Địa chỉ mặc định (có thể override qua <body data-*>):
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",
  // Nguồn tỷ giá (đa nguồn để tránh lỗi CORS / rate-limit)
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND:  "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD:  "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:    "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT", // có thể không luôn khả dụng
};

/* ---- GAS/FEES: ép legacy (gasPrice), không dùng EIP-1559 ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // tăng 100–200 nếu cần

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;            // viết
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei cho 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND (floor)
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Utils -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví này chưa đăng ký. Hãy bấm ‘Đăng ký’ trước.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng. Vui lòng thử lại.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thực hiện được thao tác này.",
    NOT_EXPIRED: "Đơn chưa quá hạn giao hàng."
  };
  for (const k in map) if (raw.includes(k)) return map[k];
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface(["function Error(string)"]);
      const reason = iface.parseError(data)?.args?.[0];
      if (reason) return String(reason);
    }
  }catch(_){}
  return raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.";
}

// Popup chi tiết RPC (tiện debug trên mobile)
function showRpc(err, tag="RPC"){
  try{
    const obj = {
      tag,
      code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason,
    };
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj, null, 2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}

// Chuẩn hoá VND: "1.200.000" / "1,200,000" / "1200000"
function parseVND(input){
  const digits = String(input||"").trim().replace(/[^\d]/g, "");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.replace("ipfs://", "");
  return link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s] || s));
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum);
  }
}
function initContractsForRead(){
  const muabanR = new ethers.Contract(DEFAULTS.MUABAN_ADDR, MUABAN_ABI, providerRead);
  const vinR    = new ethers.Contract(DEFAULTS.VIN_ADDR,    VIN_ABI,    providerRead);
  return { muabanR, vinR };
}
function initContractsForWrite(){
  muaban = new ethers.Contract(DEFAULTS.MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(DEFAULTS.VIN_ADDR,    VIN_ABI,    signer);
  return { muaban, vin };
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
async function fetchVinToVND(){
  try{
    // Override thủ công qua <body data-vin-vnd="631214">
    const override = Number(document.body.dataset.vinVnd);
    if (Number.isFinite(override) && override > 0){
      vinVND = Math.floor(override);
      vinPerVNDWei = ethers.BigNumber.from(10**18).div(vinVND);
      renderPriceChip();
      return;
    }

    // Nguồn 1: CoinGecko VIC/VND trực tiếp
    try{
      const res = await fetch(DEFAULTS.COINGECKO_VIC_VND);
      if (res.ok){
        const j = await res.json();
        const vnd = Number(j.viction?.vnd);
        if (Number.isFinite(vnd) && vnd > 0){
          vinVND = Math.floor(vnd);
          vinPerVNDWei = ethers.BigNumber.from(10**18).div(vinVND);
          renderPriceChip();
          return;
        }
      }
    }catch(_){}

    // Nguồn 2: CoinGecko VIC/USD * USD/VND
    try{
      const [res1, res2] = await Promise.all([
        fetch(DEFAULTS.COINGECKO_VIC_USD),
        fetch(DEFAULTS.COINGECKO_USD_VND)
      ]);
      if (res1.ok && res2.ok){
        const j1 = await res1.json();
        const j2 = await res2.json();
        const usd = Number(j1.viction?.usd);
        const vnd = Number(j2.tether?.vnd);
        if (Number.isFinite(usd) && Number.isFinite(vnd) && usd > 0 && vnd > 0){
          vinVND = Math.floor(usd * vnd);
          vinPerVNDWei = ethers.BigNumber.from(10**18).div(vinVND);
          renderPriceChip();
          return;
        }
      }
    }catch(_){}

    // Nguồn 3: Binance VIC/USDT * USD/VND
    try{
      const [res1, res2] = await Promise.all([
        fetch(DEFAULTS.BINANCE_VICUSDT),
        fetch(DEFAULTS.COINGECKO_USD_VND)
      ]);
      if (res1.ok && res2.ok){
        const j1 = await res1.json();
        const j2 = await res2.json();
        const usdt = Number(j1.price);
        const vnd = Number(j2.tether?.vnd);
        if (Number.isFinite(usdt) && Number.isFinite(vnd) && usdt > 0 && vnd > 0){
          vinVND = Math.floor(usdt * vnd);
          vinPerVNDWei = ethers.BigNumber.from(10**18).div(vinVND);
          renderPriceChip();
          return;
        }
      }
    }catch(_){}
  }catch(e){ console.error("fetchVinToVND:", e); }
  vinVND = 0;
  vinPerVNDWei = ethers.BigNumber.from(0);
  renderPriceChip();
}
function renderPriceChip(){
  const el = $("#priceChip");
  if (!el) return;
  if (!vinVND) {
    el.innerText = "Đang tải tỷ giá...";
    return;
  }
  el.innerText = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;
}

/* -------------------- Wallet -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum) return toast("Cài ví MetaMask trước.");
    const accs = await providerWrite.send("eth_requestAccounts", []);
    account = accs[0];
    signer = providerWrite.getSigner();
    initContractsForWrite();

    const { muabanR } = initContractsForRead();
    isRegistered = await muabanR.registered(account);
    await loadBalances();
    await loadAllProducts(muabanR);
    await loadMyProducts(muabanR);
    await loadMyOrders(muabanR);

    renderWalletBox();
    bindSearchAndForms();
    show($("#menuBox"));
    if (isRegistered) show($("#btnRegister").parentElement);
    else show($("#btnRegister"));
  }catch(e){ showRpc(e, "connectWallet"); }
}
async function disconnectWallet(){
  account = null;
  signer = null;
  muaban = null;
  vin = null;
  isRegistered = false;
  productsCache = [];
  ordersBuyer = [];
  ordersSeller = [];
  renderWalletBox();
  renderProducts();
  renderOrders();
  hide($("#menuBox"));
}
async function loadBalances(){
  try{
    const { vinR } = initContractsForRead();
    const vinBal = await vinR.balanceOf(account);
    const vicBal = await providerRead.getBalance(account);
    $("#walletVIN").innerText = ethers.utils.formatUnits(vinBal, 18);
    $("#walletVIC").innerText = ethers.utils.formatUnits(vicBal, 18);
  }catch(e){ console.error("loadBalances:", e); }
}
function renderWalletBox(){
  if (!account){
    show($("#btnConnect"));
    hide($("#walletBox"));
    return;
  }
  $("#walletAddr").innerText = short(account);
  loadBalances();
  hide($("#btnConnect"));
  show($("#walletBox"));
}

/* -------------------- Đăng ký -------------------- */
async function registerWallet(){
  if (isRegistered) return toast("Ví đã đăng ký.");
  try{
    // Preflight: simulate
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    toast("Đăng ký thành công!");
    isRegistered = true;
    show($("#btnRegister").parentElement);
  }catch(e){ showRpc(e, "registerWallet.catch"); }
}

/* -------------------- Build overrides (ép legacy) -------------------- */
async function buildOverrides(level="med"){
  const gasPrice = ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei");
  let gasLimit;
  switch(level){
    case "light": gasLimit = GAS_LIMIT_LIGHT; break;
    case "med":   gasLimit = GAS_LIMIT_MED; break;
    case "heavy": gasLimit = GAS_LIMIT_HEAVY; break;
    default: gasLimit = GAS_LIMIT_MED;
  }
  return {
    type: 0, // Ép legacy
    gasPrice,
    gasLimit
  };
}

/* -------------------- Load ABI -------------------- */
async function loadAbis(){
  try{
    const resM = await fetch("./Muaban_ABI.json");
    MUABAN_ABI = await resM.json();

    const resV = await fetch("./VinToken_ABI.json");
    VIN_ABI = await resV.json();
  }catch(e){ showRpc(e, "loadAbis"); }
}

/* -------------------- Sản phẩm -------------------- */
async function loadAllProducts(muabanR){
  try{
    productsCache = [];
    let pid = 1;
    while(true){
      try{
        const p = await muabanR.getProduct(pid);
        if (p.seller === ethers.constants.AddressZero) break;
        productsCache.push(p);
        pid++;
      }catch(_){ break; }
    }
    renderProducts();
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(filter=""){
  const wrap = $("#productsList");
  if (!wrap) return;
  wrap.innerHTML = "";
  const lowerFilter = filter.toLowerCase().trim();

  const filtered = productsCache.filter(p=>{
    if (!lowerFilter) return true;
    return p.name.toLowerCase().includes(lowerFilter);
  });

  if (!filtered.length){
    wrap.innerHTML = `<div class="tag">Không tìm thấy sản phẩm.</div>`;
    return;
  }

  filtered.forEach(p=>{
    const isSeller = (p.seller.toLowerCase() === account?.toLowerCase());
    const isBuyer = !!account && !isSeller;
    const active = p.active;
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${ipfsToHttp(p.imageCID)}" alt="">
      <div class="product-info">
        <div class="product-top">
          <span class="product-name">${escapeHtml(p.name)}</span>
          <span class="badge mono">#${p.productId}</span>
        </div>
        <div class="product-price">${p.priceVND.toLocaleString("vi-VN")} VND <span class="unit">/ ${parseUnitFromCID(p.descriptionCID)}</span></div>
        <div class="product-status">Trạng thái: ${active ? "Còn hàng" : "Hết hàng"}</div>
        <div class="card-actions">
          ${isBuyer && active ? `<button class="btn primary" data-action="buy" data-pid="${p.productId}">Mua</button>` : ""}
          ${isSeller ? `<button class="btn" data-action="edit" data-pid="${p.productId}">Cập nhật</button>` : ""}
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=>showBuyModal(p.productId));
    card.querySelector('[data-action="edit"]')?.addEventListener("click", ()=>showEditModal(p));
    wrap.appendChild(card);
  });
}

/* -------------------- My products -------------------- */
async function loadMyProducts(muabanR){
  try{
    if (!account) return;
    const pids = await muabanR.getSellerProductIds(account);
    const myProducts = await Promise.all(pids.map(pid=>muabanR.getProduct(pid)));
    // Có thể render riêng nếu cần, nhưng hiện tại dùng chung productsCache
  }catch(e){ console.error("loadMyProducts:", e); }
}

/* -------------------- Modals & Forms -------------------- */
function bindSearchAndForms(){
  $("#btnSearch")?.addEventListener("click", ()=>{
    const q = $("#searchInput").value;
    renderProducts(q);
  });

  $("#btnRegister")?.addEventListener("click", registerWallet);

  $("#btnCreate")?.addEventListener("click", showCreateModal);
  $("#btnOrdersBuy")?.addEventListener("click", showOrdersBuyModal);
  $("#btnOrdersSell")?.addEventListener("click", showOrdersSellModal);

  $("#formCreate [data-action='submit']")?.addEventListener("click", submitCreate);
  $("#formEdit [data-action='submit']")?.addEventListener("click", submitEdit);
  $("#formBuy [data-action='submit']")?.addEventListener("click", submitBuy);
}

function showCreateModal(){
  show($("#modalCreate"));
}
async function submitCreate(){
  try{
    const name = $("#createName").value.trim();
    const imageCID = $("#createImage").value.trim();
    const descCID = `unit:${$("#createUnit").value.trim()}`;
    const priceVND = parseVND($("#createPrice").value);
    const deliveryDaysMax = Number($("#createDelivery").value);
    const payoutWallet = $("#createPayout").value.trim();
    const active = true;

    if (!name) return toast("Tên sản phẩm không được để trống.");
    if (name.length > 500) return toast("Tên sản phẩm ≤ 500 ký tự.");
    if (isNaN(priceVND) || priceVND <= 0) return toast("Giá VND phải > 0.");
    if (isNaN(deliveryDaysMax) || deliveryDaysMax < 1) return toast("Thời gian giao hàng ≥ 1 ngày.");
    if (!ethers.utils.isAddress(payoutWallet)) return toast("Ví nhận thanh toán không hợp lệ.");

    // Preflight
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      const ov = await buildOverrides("heavy");
      const tx = await muaban.createProduct(
        name, descCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active, ov
      );
      await tx.wait();
    }catch(e){ showRpc(e, "send.createProduct"); return; }

    toast("Đăng sản phẩm thành công!");
    hide($("#modalCreate"));
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate.catch"); }
}

function showEditModal(p){
  $("#editPid").value = p.productId;
  $("#editPrice").value = p.priceVND.toString();
  $("#editDelivery").value = p.deliveryDaysMax;
  $("#editPayout").value = p.payoutWallet;
  $("#editActive").checked = p.active;
  show($("#modalEdit"));
}
async function submitEdit(){
  try{
    const pid = Number($("#editPid").value);
    const priceVND = parseVND($("#editPrice").value);
    const deliveryDaysMax = Number($("#editDelivery").value);
    const payoutWallet = $("#editPayout").value.trim();
    const active = $("#editActive").checked;

    if (isNaN(priceVND) || priceVND <= 0) return toast("Giá VND phải > 0.");
    if (isNaN(deliveryDaysMax) || deliveryDaysMax < 1) return toast("Thời gian giao hàng ≥ 1 ngày.");
    if (!ethers.utils.isAddress(payoutWallet)) return toast("Ví nhận thanh toán không hợp lệ.");

    // Preflight
    try{
      const txData = await muaban.populateTransaction.updateProduct(
        pid, priceVND, deliveryDaysMax, payoutWallet, active
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.updateProduct(
        pid, priceVND, deliveryDaysMax, payoutWallet, active, ov
      );
      await tx.wait();
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    toast("Cập nhật sản phẩm thành công!");
    hide($("#modalEdit"));
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitEdit.catch"); }
}

function showBuyModal(pid){
  $("#buyPid").value = pid;
  $("#buyQuantity").value = 1;
  updateBuyTotal();
  show($("#modalBuy"));
}
function updateBuyTotal(){
  const pid = Number($("#buyPid").value);
  const qty = Number($("#buyQuantity").value);
  const p = productsCache.find(x=>x.productId===pid);
  if (!p || isNaN(qty) || qty < 1) {
    $("#buyTotal").innerText = "0";
    return;
  }
  const totalVND = p.priceVND * qty;
  const vinAmt = ethers.BigNumber.from(totalVND).mul(vinPerVNDWei).div(ethers.BigNumber.from(10**18).div(vinVND + 1)); // ceil approx
  $("#buyTotal").innerText = ethers.utils.formatUnits(vinAmt, 18);
}
async function submitBuy(){
  try{
    const pid = Number($("#buyPid").value);
    const qty = Number($("#buyQuantity").value);
    const name = $("#buyName").value.trim();
    const addr = $("#buyAddr").value.trim();
    const phone = $("#buyPhone").value.trim();
    const note = $("#buyNote").value.trim();
    const cipher = `name:${name}|addr:${addr}|phone:${phone}|note:${note}`; // TODO: mã hóa thực tế

    if (isNaN(qty) || qty < 1) return toast("Số lượng ≥ 1.");
    if (!vinPerVNDWei.gt(0)) return toast("Tỷ giá chưa sẵn sàng.");

    // Approve VIN nếu cần
    const allowance = await vin.allowance(account, DEFAULTS.MUABAN_ADDR);
    const needVin = ethers.BigNumber.from(p.priceVND).mul(qty).mul(vinPerVNDWei);
    if (allowance.lt(needVin)){
      try{
        const ov = await buildOverrides("light");
        const tx = await vin.approve(DEFAULTS.MUABAN_ADDR, ethers.constants.MaxUint256, ov);
        await tx.wait();
      }catch(e){ showRpc(e, "send.approve"); return; }
    }

    // Preflight
    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    toast("Đặt hàng thành công!");
    hide($("#modalBuy"));
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy.catch"); }
}

/* -------------------- Đơn hàng -------------------- */
function showOrdersBuyModal(){
  renderOrders();
  show($("#modalOrdersBuy"));
}
function showOrdersSellModal(){
  renderOrders();
  show($("#modalOrdersSell"));
}
async function loadMyOrders(muabanR){
  try{
    if (!account) return;

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");

    const logs = await providerRead.getLogs({ address: DEFAULTS.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = []; ordersSeller = [];
    for (const l of logs){
      const parsed = iface.parseLog(l);
      const orderId = parsed.args.orderId.toNumber();
      const buyer = parsed.args.buyer.toLowerCase();
      const productId = parsed.args.productId.toNumber();

      const o = await muabanR.getOrder(orderId);
      const p = await muabanR.getProduct(productId);
      const isBuyer = (buyer === account?.toLowerCase());
      const isSeller = (p.seller?.toLowerCase() === account?.toLowerCase());

      const item = { order: o, product: p, orderId, productId };
      if (isBuyer) ordersBuyer.push(item);
      if (isSeller) ordersSeller.push(item);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function renderOrders(){
  const bWrap = $("#ordersBuyList");
  if (bWrap){
    bWrap.innerHTML = "";
    if (!ordersBuyer.length){
      bWrap.innerHTML = `<div class="tag">Chưa có đơn mua.</div>`;
    }else{
      ordersBuyer.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const canConfirm = Number(order.status)===1 && order.buyer.toLowerCase()===account.toLowerCase();
        const canRefund = canConfirm && (Number(order.deadline)*1000 < Date.now());
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>
          <div class="card-actions">
            ${canConfirm? `<button class="btn primary" data-action="confirm" data-oid="${orderId}">Xác nhận đã nhận</button>`:""}
            ${canRefund? `<button class="btn" data-action="refund" data-oid="${orderId}">Hoàn tiền (quá hạn)</button>`:""}
          </div>`;
        card.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=>confirmReceipt(orderId));
        card.querySelector('[data-action="refund"]')?.addEventListener("click", ()=>refundExpired(orderId));
        bWrap.appendChild(card);
      });
    }
  }

  const sWrap = $("#ordersSellList");
  if (sWrap){
    sWrap.innerHTML = "";
    if (!ordersSeller.length){
      sWrap.innerHTML = `<div class="tag">Chưa có đơn bán.</div>`;
    }else{
      ordersSeller.sort((a,b)=>b.orderId-a.orderId).forEach(({order, product, orderId, productId})=>{
        const card = document.createElement("div");
        card.className = "order-card";
        card.innerHTML = `
          <div class="order-row"><span class="order-strong">${escapeHtml(product.name)}</span> <span class="badge mono">#${productId}</span></div>
          <div class="order-row">Mã đơn: <span class="order-strong mono">#${orderId}</span> · Buyer: ${short(order.buyer)}</div>
          <div class="order-row">Số lượng: ${order.quantity} · VIN escrow: ${ethers.utils.formatUnits(order.vinAmount,18)}</div>
          <div class="order-row">Hạn giao: ${new Date(Number(order.deadline)*1000).toLocaleString("vi-VN")}</div>
          <div class="order-row">Trạng thái: ${statusText(order.status)}</div>`;
        sWrap.appendChild(card);
      });
    }
  }
}
async function confirmReceipt(orderId){
  try{
    try{
      const txData = await muaban.populateTransaction.confirmReceipt(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.confirmReceipt(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.confirmReceipt"); return; }
    toast("Đã xác nhận nhận hàng. VIN đã giải ngân cho người bán.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "confirmReceipt.catch"); }
}
async function refundExpired(orderId){
  try{
    try{
      const txData = await muaban.populateTransaction.refundIfExpired(orderId);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }
    try{
      const ov = await buildOverrides("light");
      const tx = await muaban.refundIfExpired(orderId, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.refundIfExpired"); return; }
    toast("Đã hoàn tiền về ví (đơn quá hạn).");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "refundExpired.catch"); }
}

/* -------------------- Bind & Main -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$$('.modal').forEach(m=>{
  m.addEventListener("click", (e)=>{ if (e.target.classList.contains('modal')) hide(e.currentTarget); });
});

(async function main(){
  try{ await loadAbis(); }catch(e){ showRpc(e, "loadAbis"); return; }
  initProviders();
  await fetchVinToVND();
  setInterval(fetchVinToVND, 60_000);
  const { muabanR } = initContractsForRead();
  await loadAllProducts(muabanR);
  $("#menuBox")?.classList.add('hidden');
})();
