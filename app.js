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

/* -------------------- ABI & Providers -------------------- */
async function loadAbis(){
  const a = await fetch("Muaban_ABI.json", {cache:"no-store"}).then(r=>r.json());
  const b = await fetch("VinToken_ABI.json", {cache:"no-store"}).then(r=>r.json());
  MUABAN_ABI = a; VIN_ABI = b;
}

function readAddrs(){
  const body = document.body;
  return {
    CHAIN_ID: Number(body.dataset.chainId||DEFAULTS.CHAIN_ID),
    RPC_URL: body.dataset.rpcUrl||DEFAULTS.RPC_URL,
    EXPLORER: body.dataset.explorer||DEFAULTS.EXPLORER,
    MUABAN_ADDR: body.dataset.muabanAddr||DEFAULTS.MUABAN_ADDR,
    VIN_ADDR: body.dataset.vinAddr||DEFAULTS.VIN_ADDR,
    REG_FEE_WEI: body.dataset.regFeeWei||DEFAULTS.REG_FEE_WEI,
  };
}

function initProviders(){
  const { RPC_URL } = readAddrs();
  providerRead = new ethers.providers.JsonRpcProvider(RPC_URL);
  if (window.ethereum){
    providerWrite = new ethers.providers.Web3Provider(window.ethereum);
  }
}

function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  const muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  const vinR    = new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead);
  return { muabanR, vinR };
}

function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR, VIN_ABI, signer);
}

/* -------------------- Wallet -------------------- */
async function ensureVictionAfterUnlock(){
  const { CHAIN_ID, RPC_URL, EXPLORER } = readAddrs();
  const eth = window.ethereum; if (!eth) throw new Error("Không có MetaMask");
  const cid = await eth.request({ method:"eth_chainId" });
  if (cid === ethers.utils.hexValue(CHAIN_ID)) return;
  try{
    await eth.request({ method:"wallet_switchEthereumChain", params:[{ chainId: ethers.utils.hexValue(CHAIN_ID) }] });
  }catch(err){
    if (err && err.code === 4902){
      await eth.request({ method:"wallet_addEthereumChain", params:[{
        chainId: ethers.utils.hexValue(CHAIN_ID),
        chainName: "Viction Mainnet",
        nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
        rpcUrls: [RPC_URL],
        blockExplorerUrls: [EXPLORER]
      }]});
    }else{ throw err; }
  }
}

async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await window.ethereum.request({ method:"eth_requestAccounts" });

    // luôn switch sang VIC ngay sau unlock
    try{ await ensureVictionAfterUnlock(); }catch(e){ showRpc(e, "ensureViction"); return; }

    providerWrite = new ethers.providers.Web3Provider(window.ethereum);
    signer  = providerWrite.getSigner();
    account = (await signer.getAddress());

    initContractsForWrite();

    $("#walletBox").classList.remove("hidden");
    $("#accountShort").textContent = short(account);

    await refreshBalances();

    // Kiểm tra trạng thái đăng ký
    const { muabanR } = initContractsForRead();
    isRegistered = await muabanR.registered(account);
    if (!isRegistered){ show($("#btnRegister")); } else { hide($("#btnRegister")); }

    // Hiện menu cho người đã kết nối ví
    show($("#menuBox"));

    // load đơn hàng của tôi (nếu có)
    await loadMyOrders(muabanR);

  }catch(e){ showRpc(e, "connectWallet"); }
}

async function disconnectWallet(){
  signer = undefined; account = undefined; providerWrite = undefined; muaban = undefined; vin = undefined; isRegistered = false;
  $("#walletBox").classList.add("hidden");
  $("#menuBox").classList.add("hidden");
}

async function refreshBalances(){
  try{
    const { vinR } = initContractsForRead();
    const [vinBal, vicBal] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account)
    ]);
    $("#vinBalance").textContent = Number(ethers.utils.formatUnits(vinBal,18)).toFixed(3);
    $("#vicBalance").textContent = Number(ethers.utils.formatUnits(vicBal,18)).toFixed(3);
  }catch(_){ }
}

$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);

/* -------------------- GAS overrides -------------------- */
async function buildOverrides(kind){
  const chain = await providerWrite.getNetwork();
  const fee = await providerWrite.getGasPrice();
  const gasPrice = ethers.utils.parseUnits(String(Math.max(Number(LEGACY_GAS_PRICE_GWEI), Number(ethers.utils.formatUnits(fee, "gwei")))), "gwei");
  const map = { light: GAS_LIMIT_LIGHT, med: GAS_LIMIT_MED, heavy: GAS_LIMIT_HEAVY };
  return { type: 0, gasPrice, gasLimit: map[kind] || GAS_LIMIT_MED, chainId: chain.chainId };
}

/* -------------------- Tỷ giá VIN ↔ VND -------------------- */
async function fetchVinToVND(){
  try{
    const body = document.body;
    if (body.dataset.vinVnd){
      const n = Number(body.dataset.vinVnd);
      if (Number.isFinite(n) && n>0){ vinVND = Math.floor(n); vinPerVNDWei = ethers.utils.parseUnits((1/n).toFixed(18), 18); updateRateUI(); return; }
    }

    // lấy VIC/USDT từ Binance nếu có
    let vicUsd = 0; try{ const r = await fetch(DEFAULTS.BINANCE_VICUSDT, {cache:"no-store"}).then(r=>r.json()); vicUsd = Number(r?.price||0); }catch(_){ }
    // fallback Coingecko
    let vicVnd = 0; try{ const r = await fetch(DEFAULTS.COINGECKO_VIC_VND, {cache:"no-store"}).then(r=>r.json()); vicVnd = Number(r?.viction?.vnd||0); }catch(_){ }
    let usdVnd = 0; try{ const r = await fetch(DEFAULTS.COINGECKO_USD_VND, {cache:"no-store"}).then(r=>r.json()); usdVnd = Number(r?.tether?.vnd||0); }catch(_){ }
    if (!vicVnd && vicUsd && usdVnd) vicVnd = Math.floor(vicUsd*usdVnd);

    // 1 VIN = 100 VIC (đặc tả)
    if (vicVnd>0){
      vinVND = Math.floor(vicVnd * 100);
      vinPerVNDWei = ethers.utils.parseUnits((1/vinVND).toFixed(18), 18);
      updateRateUI();
    }
  }catch(e){ console.warn("fetchVinToVND:", e); }
}

function updateRateUI(){
  const el = $("#vinVndRate");
  if (el){ el.textContent = `1 VIN = ${vinVND.toLocaleString('vi-VN')} VND`; }
}

/* -------------------- Sản phẩm -------------------- */
async function loadAllProducts(muabanR){
  const iface = new ethers.utils.Interface(MUABAN_ABI);
  const topic = iface.getEventTopic("ProductCreated");
  const { MUABAN_ADDR } = readAddrs();
  const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

  const list = [];
  for (const l of logs){
    const parsed = iface.parseLog(l);
    const pid = parsed.args.productId.toNumber();
    try{
      const p = await muabanR.getProduct(pid);
      if (p && p.seller !== ethers.constants.AddressZero){ list.push(p); }
    }catch(_){ }
  }
  productsCache = list; renderProducts();
}

function renderProducts(){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (const p of productsCache){
    const activeTxt = p.active ? "Còn hàng" : "Hết hàng";
    const unit = (p.descriptionCID||"").startsWith("unit:") ? p.descriptionCID.slice(5) : "-";
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="thumb"><img src="${p.imageCID}" onerror="this.src='https://via.placeholder.com/240x160?text=No+Image'"/></div>
      <div class="meta">
        <div class="name">${p.name}</div>
        <div class="price">Giá: ${Number(p.priceVND).toLocaleString('vi-VN')} VND / ${unit}</div>
        <div class="status ${p.active? 'ok':'off'}">Trạng thái: ${activeTxt}</div>
      </div>
      <div class="actions">
        <button class="btn buy" data-pid="${p.productId}">Mua</button>
        <button class="btn upd" data-pid="${p.productId}">Cập nhật</button>
      </div>`;
    wrap.appendChild(card);
  }

  wrap.querySelectorAll(".btn.buy").forEach(b=> b.addEventListener("click", (e)=>openBuyForm(Number(e.currentTarget.dataset.pid))));
  wrap.querySelectorAll(".btn.upd").forEach(b=> b.addEventListener("click", (e)=>openUpdateForm(Number(e.currentTarget.dataset.pid))));
}

$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ("#searchInput");
  const kw = (q && q.value||"").trim().toLowerCase();
  if (!kw){ renderProducts(); return; }
  const f = productsCache.filter(p=> (p.name||"").toLowerCase().includes(kw));
  const saved = productsCache; productsCache = f; renderProducts(); productsCache = saved;
});

/* ---- Đăng ký tài khoản ---- */
$("#btnRegister")?.addEventListener("click", async()=>{
  if (!providerWrite || !signer){ toast("Vui lòng kết nối ví trước."); return; }
  try{
    // preflight
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account; await providerWrite.call(txData);
    }catch(sim){ toast(parseRevert(sim)); return; }

    const ov = await buildOverrides("med");
    const tx = await muaban.payRegistration(ov);
    await tx.wait();
    toast("Đăng ký thành công.");
    isRegistered = true; hide($("#btnRegister"));
  }catch(e){ showRpc(e, "send.payRegistration"); }
});

/* ---- Form Đăng sản phẩm ---- */
$("#btnCreate")?.addEventListener("click", ()=>{ show($("#formCreate")); });
$("#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    if (!providerWrite || !signer){ toast("Vui lòng kết nối ví trước."); return; }
    if (!isRegistered){ toast("Ví này chưa đăng ký. Vui lòng bấm ‘Đăng ký’. "); return; }

    const name = ($("#createName").value||"").trim().slice(0,500);
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceV = parseVND($("#createPrice").value);
    const wallet = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);

    if (!name || !ipfs || !unit || !Number.isFinite(priceV) || priceV<=0 || !wallet || days<=0){ toast("Vui lòng nhập đủ và đúng thông tin."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceV));
    const active = true;

    // Preflight: createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, active)
    try{
      const txData = await muaban.populateTransaction.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, active);
      txData.from = account; await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // Send
    const ov = await buildOverrides("heavy");
    const tx = await muaban.createProduct(name, descriptionCID, imageCID, priceVND, days, wallet, active, ov);
    await tx.wait();

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitCreate.catch"); }
}

/* ---- Form Cập nhật sản phẩm ---- */
function openUpdateForm(pid){
  const p = productsCache.find(x=> Number(x.productId)===Number(pid)); if (!p){ toast("Không tìm thấy sản phẩm."); return; }
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = Number(p.priceVND).toLocaleString('vi-VN');
  $("#updateDays").value = Number(p.deliveryDaysMax);
  $("#updateWallet").value = p.payoutWallet;
  $("#updateActive").checked = Boolean(p.active);
  show($("#formUpdate"));
}

$("#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

async function submitUpdate(){
  try{
    if (!providerWrite || !signer){ toast("Vui lòng kết nối ví trước."); return; }
    if (!isRegistered){ toast("Ví này chưa đăng ký."); return; }

    const pid = Number($("#updatePid").value||0);
    const priceV = parseVND($("#updatePrice").value);
    const days = Number($("#updateDays").value||0);
    const wallet = ($("#updateWallet").value||"").trim();
    const active = !!$("#updateActive").checked;
    if (!pid || !Number.isFinite(priceV) || priceV<=0 || days<=0 || !wallet){ toast("Thông tin chưa hợp lệ."); return; }

    const priceVND = ethers.BigNumber.from(String(priceV));

    // preflight
    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
      txData.from = account; await providerWrite.call(txData);
    }catch(sim){ toast(parseRevert(sim)); return; }

    const ov = await buildOverrides("med");
    const tx = await muaban.updateProduct(pid, priceVND, days, wallet, active, ov);
    await tx.wait();

    hide($("#formUpdate"));
    toast("Cập nhật sản phẩm thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate.catch"); }
}

/* ---- Form Mua hàng ---- */
let currentBuying = null;
function openBuyForm(pid){
  const p = productsCache.find(x=> Number(x.productId)===Number(pid)); if (!p){ toast("Không tìm thấy sản phẩm."); return; }
  currentBuying = { pid, product: p };
  $("#buyProductInfo").textContent = `${p.name} — ${Number(p.priceVND).toLocaleString('vi-VN')} VND / ${(p.descriptionCID||'').replace(/^unit:/,'')||'-'}`;
  $("#buyQty").value = 1;
  updateBuyVin();
  show($("#formBuy"));
}

$("#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", updateBuyVin);

function updateBuyVin(){
  try{
    const qty = Math.max(1, Number($("#buyQty").value||1));
    if (!currentBuying) return;
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmt = totalVND.mul(vinPerVNDWei);
    // Hiển thị tối đa 6 chữ số thập phân cho VIN
    const txt = Number(ethers.utils.formatUnits(vinAmt,18)).toLocaleString("en-US",{maximumFractionDigits:6});
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${txt} VIN`;
  }catch(_){
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: .`;
  }
}
async function submitBuy(){
  if (!currentBuying){ toast("Thiếu thông tin sản phẩm."); return; }
  try{
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const info = {
      name: ($("#buyName").value||"").trim(),
      addr: ($("#buyAddress").value||"").trim(),
      phone: ($("#buyPhone").value||"").trim(),
      note: ($("#buyNote").value||"").trim()
    };
    if (!info.name || !info.addr || !info.phone){ toast("Vui lòng nhập đủ họ tên, địa chỉ, SĐT."); return; }
    if (vinPerVNDWei.isZero()){ toast("Tỷ giá VIN/VND chưa sẵn sàng, vui lòng thử lại."); return; }
    if (!isRegistered){ toast("Ví này chưa đăng ký. Vui lòng bấm ‘Đăng ký’. "); return; }

    const pid = currentBuying.pid;
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmount = totalVND.mul(vinPerVNDWei);

    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(vinAmount)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, vinAmount, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "send.approve.placeOrder"); return; }
    }

    const cipher = btoa(unescape(encodeURIComponent(JSON.stringify(info))));

    // Preflight placeOrder
    try{
      const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){
      toast(parseRevert(simErr)); return;
    }

    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei, cipher, ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    hide($("#formBuy"));
    toast("Đặt mua thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy.catch"); }
}

$("#btnSubmitBuy")?.addEventListener("click", submitBuy);

/* ---- Danh sách đơn ---- */
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
  window.scrollTo({top: $("#ordersBuySection").offsetTop - 20, behavior:"smooth"});
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
  window.scrollTo({top: $("#ordersSellSection").offsetTop - 20, behavior:"smooth"});
});

async function loadMyOrders(muabanR){
  if (!account) return;
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

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
    for (const it of ordersBuyer){
      const el = document.createElement("div");
      el.className = "order-item";
      el.innerHTML = `#${it.orderId} — ${it.product.name} — SL: ${it.order.quantity} — VIN: ${ethers.utils.formatUnits(it.order.vinAmount,18)}`;
      bWrap.appendChild(el);
    }
  }
  const sWrap = $("#ordersSellList");
  if (sWrap){
    sWrap.innerHTML = "";
    for (const it of ordersSeller){
      const el = document.createElement("div");
      el.className = "order-item";
      el.innerHTML = `#${it.orderId} — ${it.product.name} — SL: ${it.order.quantity} — VIN: ${ethers.utils.formatUnits(it.order.vinAmount,18)}`;
      sWrap.appendChild(el);
    }
  }
}

/* ---- Liên kết nhanh ---- */
function openOnScan(type, id){
  const { EXPLORER } = readAddrs();
  if (type==='tx') window.open(`${EXPLORER}/tx/${id}`, '_blank');
  if (type==='addr') window.open(`${EXPLORER}/address/${id}`, '_blank');
}

// Gắn các anchor explorer nếu có
$("#viewContract")?.addEventListener("click", ()=>{
  const { MUABAN_ADDR } = readAddrs(); openOnScan('addr', MUABAN_ADDR);
});
$("#viewVinToken")?.addEventListener("click", ()=>{
  const { VIN_ADDR } = readAddrs(); openOnScan('addr', VIN_ADDR);
});

/* ---- Khởi tạo ---- */
$("#btnSubmitBuy")?.addEventListener("click", submitBuy);

$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$$(".modal").forEach(m=>{
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
