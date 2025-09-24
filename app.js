/* ====================================================================
   muaban.vin — app.js (ethers v5)
   MỤC TIÊU: sửa lỗi "Internal JSON-RPC error" khi ký giao dịch & ổn định UI
   - ÉP GIAO DỊCH LEGACY (type 0) dùng gasPrice; KHÔNG gửi EIP-1559 trên VIC
   - Preflight mọi giao dịch (populateTransaction + provider.call({from}))
     để bắt revert rõ ràng (NOT_REGISTERED, PRICE_REQUIRED, ...)
   - Giá VIN/VND: (VIC/USDT từ Binance × 100) × (USDT/VND từ CoinGecko)
     + fallback khác + có thể override qua <body data-vin-vnd="...">
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
  // Địa chỉ contract (có thể override qua <body data-*>):
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  // Phí đăng ký 0.001 VIN (18 decimals)
  REG_FEE_WEI: "1000000000000000",
  // Nguồn tỉ giá:
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* ---- GAS: ép legacy (type 0) ---- */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");   // approve / confirm / refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");   // payRegistration / updateProduct / placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");   // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // có thể tăng 100–200 nếu mạng bận

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR;  // đọc
let muaban,  vin;   // ghi
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

// Popup chi tiết RPC (debug cả trên mobile)
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

/* -------------------- ABI + Address -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
}
function readAddrs(){
  const b = document.body;
  const ma = b?.dataset?.muabanAddr;
  const va = b?.dataset?.vinAddr;
  return {
    MUABAN_ADDR: (ma && ethers.utils.isAddress(ma) ? ma : DEFAULTS.MUABAN_ADDR),
    VIN_ADDR:    (va && ethers.utils.isAddress(va) ? va : DEFAULTS.VIN_ADDR)
  };
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead);
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
function bodyVinVndOverride(){
  const raw = document.body?.dataset?.vinVnd;
  const n = Number(raw);
  return Number.isFinite(n) && n>0 ? Math.floor(n) : 0;
}
async function fetchVinToVND(){
  try{
    // 1) Ưu tiên override qua data-vin-vnd
    const override = bodyVinVndOverride();
    if (override>0){
      vinVND = override;
    }else{
      // 2) Nguồn chính: Viction→VND (Coingecko)
      let vicVnd = 0;
      try{
        const r = await fetch(DEFAULTS.COINGECKO_VIC_VND);
        const j = await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){}

      if (vicVnd>0){
        vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC
      }else{
        // 3) VIC→USD × USDT→VND
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0){
          vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        }else{
          // 4) Fallback: Binance VIC/USDT × USDT/VND
          const [vicPriceRes2, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicPriceRes2.json())?.price||0);
          const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }

    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.error("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Loading price...");
  }
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (chainId=88)."); return; }
    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    initContractsForWrite();

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    isRegistered = Boolean(reg);

    refreshMenu();

    await Promise.all([loadAllProducts(), loadMyOrders()]);
  }catch(e){
    showRpc(e, "connectWallet");
  }
}
function disconnectWallet(){
  account = null; signer = null; muaban = null; vin = null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  isRegistered = false;
  refreshMenu();
}
function refreshMenu(){
  const btnReg = $("#btnRegister");
  const btnCrt = $("#btnCreate");
  const btnOB  = $("#btnOrdersBuy");
  const btnOS  = $("#btnOrdersSell");
  const menu   = $("#menuBox");
  if (!account){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = true;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
    return;
  }
  if (!isRegistered){
    btnReg?.classList.remove('hidden'); if (btnReg) btnReg.disabled = false;
    btnCrt?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
  }else{
    btnReg?.classList.add('hidden');
    btnCrt?.classList.remove('hidden'); btnOB?.classList.remove('hidden'); btnOS?.classList.remove('hidden');
  }
  menu?.classList.remove('hidden');
}

/* -------------------- Sản phẩm: load từ event & getProduct -------------------- */
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const pids = new Set();
    logs.forEach(l=>{ const parsed = iface.parseLog(l); pids.add(parsed.args.productId.toString()); });

    productsCache = [];
    for (const pid of Array.from(pids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid: Number(pid), data: p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const active = data.active;
    const price = Number(data.priceVND);
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHtml(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span> <span class="unit">/ ${escapeHtml(unit||"đv")}</span>
        </div>
        <div>
          <span class="stock-badge ${active? "":"out"}">${active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${(!account) ? "" :
            (data.seller?.toLowerCase()===account?.toLowerCase()
              ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && active ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : "")
            )
          }
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=> openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=> openUpdateForm(pid, data));
    wrap.appendChild(card);
  });
}
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { renderProducts(productsCache); return; }
  const list = productsCache.filter(({data})=> data.name.toLowerCase().includes(q));
  renderProducts(list);
});

/* -------------------- Legacy GAS overrides -------------------- */
async function buildOverrides(kind="med"){
  const ov = { type: 0, gasPrice: ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei") };
  if (kind==="light") ov.gasLimit = GAS_LIMIT_LIGHT;
  else if (kind==="heavy") ov.gasLimit = GAS_LIMIT_HEAVY;
  else ov.gasLimit = GAS_LIMIT_MED;
  return ov;
}

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();

    // ensure allowance
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, need, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    // preflight
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send
    try{
      const ov = await buildOverrides("med");
      const tx = await muaban.payRegistration(ov);
      await tx.wait();
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "btnRegister.catch"); }
});

/* -------------------- Đăng sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));

$("#btnSubmitCreate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký."); return; }

  const name = ($("#createName").value||"").trim();
  const ipfs = ($("#createIPFS").value||"").trim();
  const unit = ($("#createUnit").value||"").trim();
  const priceVND = parseVND($("#createPrice").value);
  const payout = ($("#createWallet").value||"").trim();
  const days = Number($("#createDays").value||"0");
  if (!name){ toast("Nhập tên sản phẩm."); return; }
  if (!priceVND || priceVND<=0){ toast("Giá bán (VND) phải > 0."); return; }
  if (!ethers.utils.isAddress(payout)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
  if (!(days>0)){ toast("Thời gian giao hàng (ngày) phải ≥ 1."); return; }

  const descCID = `unit:${unit||""}`; // đơn giản theo mô tả
  const imgCID  = ipfs || "";

  try{
    // preflight
    const txData = await muaban.populateTransaction.createProduct(
      name, descCID, imgCID, ethers.BigNumber.from(priceVND),
      days, payout, true
    );
    txData.from = account;
    await providerWrite.call(txData); // bắt lỗi rõ ràng

    // gửi thật
    const ov = await buildOverrides("heavy");
    const tx = await muaban.createProduct(
      name, descCID, imgCID, ethers.BigNumber.from(priceVND),
      days, payout, true, ov
    );
    await tx.wait();

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){
    toast(parseRevert(e));
    // Nếu cần debug sâu:
    // showRpc(e, "createProduct");
  }
});

/* -------------------- Cập nhật sản phẩm -------------------- */
function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND||"");
  $("#updateDays").value = String(p.deliveryDaysMax||"");
  $("#updateWallet").value = p.payoutWallet||"";
  $("#updateActive").checked = Boolean(p.active);
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));

$("#btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  const pid = Number($("#updatePid").value||"0");
  const priceVND = parseVND($("#updatePrice").value);
  const days = Number($("#updateDays").value||"0");
  const payout = ($("#updateWallet").value||"").trim();
  const active = !!$("#updateActive").checked;

  if (!(pid>0)) { toast("Thiếu ID sản phẩm."); return; }
  if (!priceVND || priceVND<=0){ toast("Giá bán (VND) phải > 0."); return; }
  if (!(days>0)) { toast("Thời gian giao hàng phải ≥ 1."); return; }
  if (!ethers.utils.isAddress(payout)){ toast("Ví nhận thanh toán không hợp lệ."); return; }

  try{
    const txData = await muaban.populateTransaction.updateProduct(
      pid, ethers.BigNumber.from(priceVND), days, payout, active
    );
    txData.from = account;
    await providerWrite.call(txData);

    const ov = await buildOverrides("med");
    const tx = await muaban.updateProduct(
      pid, ethers.BigNumber.from(priceVND), days, payout, active, ov
    );
    await tx.wait();

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){
    toast(parseRevert(e));
  }
});

/* -------------------- Mua hàng -------------------- */
function openBuyForm(pid, p){
  $("#buyPid").value = String(pid);
  $("#buyName").textContent = p.name;
  $("#buyPriceVND").textContent = Number(p.priceVND).toLocaleString("vi-VN");
  $("#buyQty").value = "1";
  $("#buyNote").value = "";
  $("#buyInfoName").value = "";
  $("#buyInfoAddr").value = "";
  $("#buyInfoPhone").value = "";
  updateBuyTotal();
  show($("#formBuy"));
}
function updateBuyTotal(){
  const qty = Math.max(1, Number($("#buyQty").value || "1"));
  const price = parseVND($("#buyPriceVND").textContent || "0");
  const totalVND = price * qty;
  let text = "Tỷ giá chưa sẵn sàng…";
  if (vinVND>0){
    const totalVIN = totalVND / vinVND;
    text = `Tổng thanh toán ≈ ${totalVIN.toFixed(6)} VIN`;
  }
  $("#buyTotal")?.replaceChildren(text);
}
$("#buyQty")?.addEventListener("input", updateBuyTotal);
$(".modal#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));

function packBuyerInfoCipher(){
  // Theo mô tả: UI mã hoá ngầm. Ở đây mã hoá tối giản base64 để tránh plaintext.
  const obj = {
    name: ($("#buyInfoName").value||"").trim(),
    addr: ($("#buyInfoAddr").value||"").trim(),
    phone:($("#buyInfoPhone").value||"").trim(),
    note: ($("#buyNote").value||"").trim(),
    ts: Date.now()
  };
  const raw = JSON.stringify(obj);
  // Placeholder encryption: base64. Có thể thay bằng AES client-side sau.
  return btoa(unescape(encodeURIComponent(raw)));
}

$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Ví chưa đăng ký."); return; }
  if (vinPerVNDWei.isZero()){ toast("Tỷ giá chưa sẵn sàng, vui lòng thử lại."); return; }

  const pid = Number($("#buyPid").value||"0");
  const qty = Math.max(1, Number($("#buyQty").value||"0"));
  if (!(pid>0) || !(qty>0)){ toast("Thiếu dữ liệu đơn hàng."); return; }

  const cipher = packBuyerInfoCipher();

  try{
    // 1) Tính toán VIN cần escrow theo công thức on-chain (sẽ check lại)
    //    Ở frontend chỉ truyền vinPerVND (wei per 1 VND)
    // 2) Đảm bảo allowance đủ lớn → lấy estimate trước bằng cách simulate placeOrder
    const txData = await muaban.populateTransaction.placeOrder(
      pid, qty, vinPerVNDWei.toString(), cipher
    );
    txData.from = account;

    // simulate để biết vinAmount cần chuyển (contract tự tính)
    // vì placeOrder dùng transferFrom nên cần approve đủ lớn. Ta approve "vin cần" sau khi simulate.
    try{
      await providerWrite.call(txData);
    }catch(simErr){
      // Nếu fail ở đây sẽ hiện đúng reason (VD: PRODUCT_NOT_ACTIVE, ...)
      throw simErr;
    }

    // Đọc lại đơn hàng vừa đặt? Không có id trước khi gửi.
    // Cách an toàn: Approve "max tạm thời" = giá trị trần = priceVND*qty/vinVND, nhưng vì
    // on-chain tính chính xác, ta sẽ approve ">= ước tính".
    // Ước tính frontend:
    const product = await muabanR.getProduct(pid);
    const totalVND = ethers.BigNumber.from(product.priceVND).mul(qty);
    const estVin = totalVND.mul(vinPerVNDWei); // (VND) * (wei/VND) = wei VIN
    // nới thêm 1% để tránh sai số làm tròn:
    const approveAmount = estVin.mul(101).div(100);

    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(approveAmount)){
      try{
        const ovA = await buildOverrides("light");
        const txA = await vin.approve(MUABAN_ADDR, approveAmount, ovA);
        await txA.wait();
      }catch(e){ showRpc(e, "approve.placeOrder"); return; }
    }

    const ov = await buildOverrides("med");
    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher, ov);
    await tx.wait();

    hide($("#formBuy"));
    toast("Đặt hàng thành công.");
    await loadMyOrders();
  }catch(e){
    toast(parseRevert(e));
  }
});

/* -------------------- Đơn hàng của tôi -------------------- */
async function loadMyOrders(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = [];
    ordersSeller = [];

    for (const l of logs){
      const parsed = iface.parseLog(l);
      const oid = parsed.args.orderId.toString();
      const ord = await muabanR.getOrder(oid);
      if (!ord || !ord.orderId) continue;
      const isBuyer  = account && ord.buyer?.toLowerCase()  === account;
      const isSeller = account && ord.seller?.toLowerCase() === account;
      if (isBuyer)  ordersBuyer.push(ord);
      if (isSeller) ordersSeller.push(ord);
    }

    renderOrders();
  }catch(e){
    console.error("loadMyOrders:", e);
  }
}

function renderOrders(){
  const buyerWrap  = $("#ordersBuyList");
  const sellerWrap = $("#ordersSellList");
  buyerWrap.innerHTML = ""; sellerWrap.innerHTML = "";

  const fmt = (wei)=>parseFloat(ethers.utils.formatUnits(wei,18)).toFixed(6);

  for (const o of ordersBuyer){
    const el = document.createElement("div");
    el.className = "order-card";
    el.innerHTML = `
      <div class="order-row"><span class="order-strong">#${o.orderId.toString()}</span> • Sản phẩm: ${o.productId.toString()} • Số lượng: ${o.quantity.toString()}</div>
      <div class="order-row">Trạng thái: ${statusText(o.status)} • VIN escrow: ${fmt(o.vinAmount)}</div>
      <div class="order-row">Hạn giao: ${new Date(Number(o.deadline)*1000).toLocaleString("vi-VN")}</div>
      <div class="card-actions">
        ${Number(o.status)===1 ? `<button class="btn" data-action="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>` : ""}
        ${Number(o.status)===1 ? `<button class="btn" data-action="refund" data-oid="${o.orderId}">Hoàn tiền khi quá hạn</button>` : ""}
      </div>
    `;
    el.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=> confirmReceipt(o.orderId));
    el.querySelector('[data-action="refund"]') ?.addEventListener("click", ()=> refundOrder(o.orderId));
    buyerWrap.appendChild(el);
  }

  for (const o of ordersSeller){
    const el = document.createElement("div");
    el.className = "order-card";
    el.innerHTML = `
      <div class="order-row"><span class="order-strong">#${o.orderId.toString()}</span> • Người mua: ${short(o.buyer)}</div>
      <div class="order-row">SP: ${o.productId.toString()} • SL: ${o.quantity.toString()} • VIN escrow: ${fmt(o.vinAmount)}</div>
      <div class="order-row">Trạng thái: ${statusText(o.status)} • Hạn giao: ${new Date(Number(o.deadline)*1000).toLocaleString("vi-VN")}</div>
    `;
    sellerWrap.appendChild(el);
  }
}

async function confirmReceipt(oid){
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const txData = await muaban.populateTransaction.confirmReceipt(oid);
    txData.from = account;
    await providerWrite.call(txData);

    const ov = await buildOverrides("light");
    const tx = await muaban.confirmReceipt(oid, ov);
    await tx.wait();
    toast("Đã xác nhận nhận hàng. Hệ thống giải ngân cho người bán.");
    await loadMyOrders();
  }catch(e){ toast(parseRevert(e)); }
}
async function refundOrder(oid){
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const txData = await muaban.populateTransaction.refund(oid);
    txData.from = account;
    await providerWrite.call(txData);

    const ov = await buildOverrides("light");
    const tx = await muaban.refund(oid, ov);
    await tx.wait();
    toast("Hoàn tiền thành công.");
    await loadMyOrders();
  }catch(e){ toast(parseRevert(e)); }
}

/* -------------------- Wire up header/menu -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  show($("#ordersSellSection")); hide($("#ordersBuySection"));
});

/* -------------------- Bootstrap -------------------- */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    initContractsForRead();
    // Hiển thị giá VIN/VND
    fetchVinToVND();
    // Tự load sản phẩm cho người dùng chưa kết nối
    await loadAllProducts();
  }catch(e){
    console.error(e);
  }
})();
