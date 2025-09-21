/* ====================================================================
   muaban.vin — app.js (ethers v5) — FIXED
   - Sửa lỗi: providerWrite chưa khởi tạo trong connectWallet()
   - Thông báo rõ ràng các bước ký/gửi/chờ xác nhận giao dịch
   - Simulate trước khi gửi để bắt reason thay vì "Internal JSON-RPC error."
   - Ép legacy tx (type:0) với gasPrice/gasLimit an toàn
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const esc = (s)=>String(s??"").replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";

/* -------------------- Toast (tối giản) -------------------- */
function toast(msg, type="info"){
  console[type==="error"?"error":"log"]("[toast]", msg);
  const el = $("#toast");
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(()=>{ el.className = "toast"; }, 3500);
}

/* -------------------- Cấu hình -------------------- */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  // Địa chỉ có thể override qua <body data-muaban-addr data-vin-addr>
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // Nguồn tỷ giá
  BINANCE_VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
  COINGECKO_USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_VND:  "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
};

/* GAS: ép legacy */
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");
const LEGACY_GAS_PRICE_GWEI = "50";

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin; // signer-wrapped
let vinVND = 0;  // 1 VIN = ? VND

/* -------------------- Utils -------------------- */
const fmt4 = (n)=> Number(n||0).toFixed(4);
const fmtVN = (n)=> Number(n||0).toLocaleString("vi-VN");
const parseVND = (s)=>{ // "1.200.000" / "1,200,000" / "1200000"
  s = String(s??"").replace(/[^\d]/g,"");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n)? n : NaN;
};

function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  try{
    const data = err?.error?.data || err?.data;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10){
      const iface = new ethers.utils.Interface([
        "error Error(string)"
      ]);
      const decoded = iface.parseError(data);
      if (decoded?.args?.[0]) return String(decoded.args[0]);
    }
  }catch {}
  return raw || "Giao dịch thất bại hoặc bị từ chối.";
}

async function buildOverrides(level="med"){
  const gasPrice = ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei");
  let gasLimit = GAS_LIMIT_MED;
  if (level==="light") gasLimit = GAS_LIMIT_LIGHT;
  else if (level==="heavy") gasLimit = GAS_LIMIT_HEAVY;
  return { type:0, gasPrice, gasLimit };
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
    VIN_ADDR:    (va && ethers.utils.isAddress(va) ? va : DEFAULTS.VIN_ADDR),
  };
}

/* -------------------- Providers & Contracts -------------------- */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  // providerWrite sẽ được tạo ngay trong connectWallet() (FIX quan trọng)
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanR: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead),
    vinR:    new ethers.Contract(VIN_ADDR,    VIN_ABI,    providerRead),
  };
}

/* -------------------- Giá VIN/VND -------------------- */
async function refreshVinPrice(){
  try{
    const [vicUsdt, usdtVnd] = await Promise.all([
      fetch(DEFAULTS.BINANCE_VICUSDT).then(r=>r.json()).then(j=>Number(j?.price||0)).catch(()=>0),
      fetch(DEFAULTS.COINGECKO_USDT_VND).then(r=>r.json()).then(j=>Number(j?.tether?.vnd||0)).catch(()=>0),
    ]);
    if (vicUsdt>0 && usdtVnd>0){
      vinVND = Math.floor(vicUsdt * 100 * usdtVnd);
    }else{
      // fallback VIC→VND × 100
      const vicVnd = await fetch(DEFAULTS.COINGECKO_VIC_VND).then(r=>r.json()).then(j=>Number(j?.viction?.vnd||0)).catch(()=>0);
      vinVND = vicVnd>0 ? Math.floor(vicVnd * 100) : 0;
    }
  }catch{ vinVND = 0; }
  const el = $("#vinPrice");
  if (el) el.textContent = vinVND>0 ? `1 VIN = ${fmtVN(vinVND)} VND` : "Loading price...";
}

/* -------------------- Balances -------------------- */
async function refreshBalances(){
  try{
    if (!account) return;
    const { vinR } = initContractsForRead();
    const [vicWei, vinRaw, vinDec] = await Promise.all([
      providerWrite.getBalance(account),
      vinR.balanceOf(account),
      vinR.decimals()
    ]);
    const vic = parseFloat(ethers.utils.formatEther(vicWei));
    const vin = parseFloat(ethers.utils.formatUnits(vinRaw, vinDec));
    $("#vicBalance") && ($("#vicBalance").textContent = `VIC: ${fmt4(vic)}`);
    $("#vinBalance") && ($("#vinBalance").textContent = `VIN: ${fmt4(vin)}`);
  }catch(e){
    console.warn("refreshBalances:", e);
  }
}

/* -------------------- Kết nối ví (FIX) -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask.", "error"); return; }

    // FIX: luôn khởi tạo providerWrite trước khi dùng
    providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");

    // yêu cầu tài khoản + kiểm tra mạng
    toast("Đang chờ bạn mở MetaMask để kết nối…");
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){
      toast("Sai mạng. Hãy chọn Viction (chainId = 88).", "error");
      return;
    }

    signer  = providerWrite.getSigner();
    account = (await signer.getAddress());
    const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);

    hide($("#btnConnect"));
    show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    await refreshBalances();

    // sau khi connect: mở menu
    $("#menuBox")?.classList.remove("hidden");
    toast("Kết nối ví thành công.");
  }catch(e){
    console.error("connectWallet:", e);
    toast(parseRevert(e), "error");
  }
}

function disconnectWallet(){
  account = undefined; signer = undefined; muaban = undefined; vin = undefined;
  show($("#btnConnect"));
  hide($("#walletBox"));
  $("#accountShort").textContent = "";
}

/* -------------------- SẢN PHẨM (load & render) -------------------- */
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(String(desc).trim());
  return m ? m[1].trim() : "";
}

async function loadAllProducts(muabanR){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics:[topic] });
    const ids = [...new Set(logs.map(l=> iface.parseLog(l).args.productId.toString() ))].sort((a,b)=>Number(a)-Number(b));

    const list = [];
    for (const pid of ids){
      const p = await muabanR.getProduct(pid);
      list.push({ pid: Number(pid), data: p });
    }
    renderProducts(list);
  }catch(e){
    console.error("loadAllProducts:", e);
  }
}

function renderProducts(list){
  const wrap = $("#productList"); if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  list.forEach(({pid, data})=>{
    const unit = esc(parseUnitFromCID(data.descriptionCID) || "đv");
    const img  = data.imageCID ? (data.imageCID.startsWith("ipfs://")? data.imageCID.replace("ipfs://","https://ipfs.io/ipfs/") : data.imageCID) : "";
    const price= Number(data.priceVND || data.priceVND?.toString?.() || "0");
    const active = !!data.active;

    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      ${img?`<img class="product-thumb" src="${esc(img)}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'">`:``}
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${esc(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${fmtVN(price)} VND</span>
          <span class="unit">/ ${unit}</span>
        </div>
        <div class="line">
          <span class="stock-badge ${active?'':'out'}">${active?'Còn hàng':'Hết hàng'}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.payoutWallet)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${account? `<button class="btn buy" data-pid="${pid}" ${active?"":"disabled"}>Mua</button>
                      <button class="btn update" data-pid="${pid}">Sửa</button>`:``}
        </div>
      </div>`;
    wrap.appendChild(card);
  });

  // gán event
  $$(".product-card .buy").forEach(b=>b.addEventListener("click", e=>{
    openBuyForm(Number(e.currentTarget.dataset.pid));
  }));
  $$(".product-card .update").forEach(b=>b.addEventListener("click", async e=>{
    const pid = Number(e.currentTarget.dataset.pid);
    const { muabanR } = initContractsForRead();
    const p = await muabanR.getProduct(pid);
    openUpdateForm(pid, p);
  }));
}

/* -------------------- CREATE PRODUCT -------------------- */
function openCreateForm(){
  if (!account){ toast("Vui lòng kết nối ví trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
}
function closeCreateForm(){ hide($("#formCreate")); }

$("#btnCreate")?.addEventListener("click", openCreateForm);
$(".modal#formCreate .close")?.addEventListener("click", closeCreateForm);

function readCreateInputs(){
  const name = ($("#createName").value||"").trim();
  const ipfs = ($("#createIPFS").value||"").trim();
  const unit = ($("#createUnit").value||"").trim();
  const priceVNDNum = parseVND($("#createPrice").value||"");
  const wallet = ($("#createWallet").value||"").trim();
  const days = Number($("#createDays").value||0);
  return { name, ipfs, unit, priceVNDNum, wallet, days };
}
function validateCreate({name, ipfs, unit, priceVNDNum, wallet, days}){
  if (!name) return "Vui lòng nhập Tên sản phẩm.";
  if (!ipfs) return "Vui lòng nhập IPFS (ảnh/video).";
  if (!unit) return "Vui lòng nhập đơn vị.";
  if (!Number.isFinite(priceVNDNum) || priceVNDNum<=0) return "Giá (VND) phải > 0.";
  if (!ethers.utils.isAddress(wallet)) return "Ví nhận thanh toán không hợp lệ.";
  if (!Number.isInteger(days) || days<=0) return "Thời gian giao hàng (ngày) phải ≥ 1.";
  return "";
}

async function submitCreate(){
  try{
    if (!account){ await connectWallet(); if (!account) return; }

    const inp = readCreateInputs();
    const err = validateCreate(inp);
    if (err){ toast(err, "error"); return; }

    const descriptionCID = `unit:${inp.unit}`;
    const imageCID = inp.ipfs;
    const priceVND = ethers.BigNumber.from(String(inp.priceVNDNum));

    // 1) simulate trước để bắt reason
    toast("Đang simulate kiểm tra giao dịch…");
    const txData = await muaban.populateTransaction.createProduct(
      inp.name, descriptionCID, imageCID, priceVND, inp.days, inp.wallet, true
    );
    txData.from = account;
    await providerWrite.call(txData).catch(e=>{ throw new Error(parseRevert(e)); });

    // 2) ký gửi
    const ov = await buildOverrides("heavy");
    toast("Đang chờ ký ví…");
    const tx = await muaban.createProduct(
      inp.name, descriptionCID, imageCID, priceVND, inp.days, inp.wallet, true, ov
    );

    toast("Đang gửi giao dịch…");
    const rc = await tx.wait();
    toast("Đăng sản phẩm thành công.");

    closeCreateForm();
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){
    toast(parseRevert(e), "error");
  }
}
$("#btnSubmitCreate")?.addEventListener("click", (ev)=>{ ev.preventDefault(); submitCreate(); });

/* -------------------- UPDATE PRODUCT -------------------- */
function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND);
  $("#updateDays").value  = String(p.deliveryDaysMax);
  $("#updateWallet").value= String(p.payoutWallet);
  $("#updateActive").checked = !!p.active;
  show($("#formUpdate"));
}
function closeUpdateForm(){ hide($("#formUpdate")); }
$(".modal#formUpdate .close")?.addEventListener("click", closeUpdateForm);

function readUpdateInputs(){
  const pid = Number($("#updatePid").value||0);
  const priceVNDNum = parseVND($("#updatePrice").value||"");
  const days = Number($("#updateDays").value||0);
  const wallet = ($("#updateWallet").value||"").trim();
  const active = !!$("#updateActive").checked;
  return { pid, priceVNDNum, days, wallet, active };
}
function validateUpdate({pid, priceVNDNum, days, wallet}){
  if (!Number.isInteger(pid) || pid<0) return "pid không hợp lệ.";
  if (!Number.isFinite(priceVNDNum) || priceVNDNum<=0) return "Giá (VND) phải > 0.";
  if (!Number.isInteger(days) || days<=0) return "Thời gian giao hàng ≥ 1.";
  if (!ethers.utils.isAddress(wallet)) return "Ví nhận thanh toán không hợp lệ.";
  return "";
}
async function submitUpdate(){
  try{
    if (!account){ await connectWallet(); if (!account) return; }
    const u = readUpdateInputs();
    const err = validateUpdate(u);
    if (err){ toast(err, "error"); return; }
    const priceVND = ethers.BigNumber.from(String(u.priceVNDNum));

    toast("Đang simulate kiểm tra cập nhật…");
    const txData = await muaban.populateTransaction.updateProduct(u.pid, priceVND, u.days, u.wallet, u.active);
    txData.from = account;
    await providerWrite.call(txData).catch(e=>{ throw new Error(parseRevert(e)); });

    const ov = await buildOverrides("med");
    toast("Đang chờ ký ví…");
    const tx = await muaban.updateProduct(u.pid, priceVND, u.days, u.wallet, u.active, ov);

    toast("Đang gửi giao dịch…");
    await tx.wait();
    toast("Cập nhật thành công.");
    closeUpdateForm();

    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){
    toast(parseRevert(e), "error");
  }
}
$("#btnSubmitUpdate")?.addEventListener("click", (e)=>{ e.preventDefault(); submitUpdate(); });

/* -------------------- BUY (tối giản, giữ nguyên id sẵn) -------------------- */
let currentBuying=null;
function openBuyForm(pid){
  currentBuying = { pid };
  $("#buyProductInfo").innerHTML = `<div><strong>Sản phẩm #${pid}</strong></div>`;
  show($("#formBuy"));
}
function closeBuyForm(){ hide($("#formBuy")); }
$(".modal#formBuy .close")?.addEventListener("click", closeBuyForm);

$("#btnSubmitBuy")?.addEventListener("click", async (e)=>{
  e.preventDefault();
  if (!currentBuying){ toast("Thiếu thông tin sản phẩm."); return; }
  toast("Đặt hàng: chức năng mẫu — vui lòng ghép đúng ABI placeOrder() nếu cần.");
  closeBuyForm();
});

/* -------------------- Bind Connect/Disconnect -------------------- */
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);

/* -------------------- Search -------------------- */
$("#btnSearch")?.addEventListener("click", ()=>{
  const kw = ($("#searchInput")?.value||"").trim().toLowerCase();
  const cards = $$("#productList .product-card");
  if (!cards.length) return;
  cards.forEach(c=>{
    const name = (c.querySelector(".product-title")?.textContent||"").toLowerCase();
    c.style.display = (!kw || name.includes(kw)) ? "" : "none";
  });
});

/* -------------------- Main -------------------- */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    await refreshVinPrice();
    setInterval(refreshVinPrice, 60_000);

    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);

    // Ẩn menu đến khi connect
    $("#menuBox")?.classList.add("hidden");

    // Auto refresh UI khi metamask đổi account/chain
    if (window.ethereum){
      window.ethereum.on?.("accountsChanged", ()=> window.location.reload());
      window.ethereum.on?.("chainChanged", ()=> window.location.reload());
    }
  }catch(e){
    console.error("main:", e);
    toast(parseRevert(e), "error");
  }
})();
