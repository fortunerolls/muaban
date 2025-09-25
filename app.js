/* ====================================================================
   muaban.vin — app.js (ethers v5)
   BẢN 4 — CHẨN ĐOÁN SÂU & GỬI TX BỀN BỈ
   - Preflight: eth_call (with from) + estimateGas (buffer 30%)
   - Kiểm tra VIC đủ phí gas trước khi gửi
   - Kiểm tra nonce pending (cảnh báo nếu có TX kẹt)
   - Gửi theo 3 tầng:
       (A) native (không override) →
       (B) legacy type 0 + gasPrice auto-bump →
       (C) EIP-1559 (getFeeData × hệ số)
   - Fallback gửi thô: signer.sendTransaction({to,data,...}) để tránh path của Contract wrapper
==================================================================== */

const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";
const toast=(m)=>alert(m);

const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE_WEI: "1000000000000000",
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND:  "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD:  "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:    "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");
const GAS_LIMIT_MED   = ethers.BigNumber.from("450000");
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("900000");
const LEGACY_GAS_STEPS = [80,120,200,400,800,1200,2000]; // gwei

let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muaban, vin;
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0);
let vinVND = 0;
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Debug helpers -------------------- */
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  if (m) return m[1];
  return raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.";
}
function showRpc(err, tag="RPC"){
  try{
    const detail = {
      tag,
      code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason,
      stack: (err?.stack||"").slice(0,300)
    };
    console.error(tag, err);
    alert(`${tag}\n${JSON.stringify(detail,null,2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}

/* -------------------- Utils -------------------- */
function parseVND(input){ const digits=String(input||"").trim().replace(/[^\d]/g,""); if(!digits) return NaN; const n=Number(digits); return Number.isFinite(n)?n:NaN; }
function ipfsToHttp(link){ if(!link) return ""; return link.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + link.slice(7) : link; }
function parseUnitFromCID(desc){ const m=/^unit:(.+)$/i.exec(desc||""); return m?m[1].trim():""; }
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s]||s)); }
function statusText(code){ return ({0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"})[Number(code)]||"-"; }

/* -------------------- ABI + Address -------------------- */
async function loadAbis(){ MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json()); VIN_ABI=await fetch("VinToken_ABI.json").then(r=>r.json()); }
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
  return {
    muabanR: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead),
    vinR:    new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead),
  };
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  return {
    muabanW: new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer),
    vinW:    new ethers.Contract(VIN_ADDR, VIN_ABI, signer),
  };
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
function bodyVinVndOverride(){
  const raw = document.body?.dataset?.vinVnd;
  const n = Number(raw);
  return Number.isFinite(n) && n>0 ? Math.floor(n) : 0;
}
async function fetchVinToVND(){
  try{
    const override=bodyVinVndOverride();
    if(override>0){ vinVND=override; }
    else{
      let vicVnd=0;
      try{ const r=await fetch(DEFAULTS.COINGECKO_VIC_VND); vicVnd = Number((await r.json())?.viction?.vnd||0);}catch{}
      if (vicVnd>0) vinVND=Math.floor(vicVnd*100);
      else{
        const [a,b]=await Promise.all([fetch(DEFAULTS.COINGECKO_VIC_USD),fetch(DEFAULTS.COINGECKO_USD_VND)]);
        const vicUsd=Number((await a.json())?.viction?.usd||0);
        const usdtVnd=Number((await b.json())?.tether?.vnd||0);
        if(vicUsd>0 && usdtVnd>0) vinVND=Math.floor(vicUsd*100*usdtVnd);
        else{
          const [c,d]=await Promise.all([fetch(DEFAULTS.BINANCE_VICUSDT),fetch(DEFAULTS.COINGECKO_USD_VND)]);
          const vicUsdt=Number((await c.json())?.price||0);
          const usdtVnd2=Number((await d.json())?.tether?.vnd||0);
          if(vicUsdt>0 && usdtVnd2>0) vinVND=Math.floor(vicUsdt*100*usdtVnd2);
        }
      }
    }
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = vinVND>0 ? ONE.div(vinVND).add(ONE.mod(vinVND).gt(0)?1:0) : ethers.BigNumber.from(0);
    $("#vinPrice")?.replaceChildren(vinVND>0?`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`:"Đang tải giá…");
  }catch{}
}

/* -------------------- Kết nối ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Chọn Viction (88)."); return; }
    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    const { muabanR, vinR } = initContractsForRead();
    const { muabanW, vinW } = initContractsForWrite();
    muaban = muabanW; vin = vinW;

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal] = await Promise.all([vinR.balanceOf(account), providerWrite.getBalance(account)]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    isRegistered = await muabanR.registered(account);
    refreshMenu();

    await Promise.all([loadAllProducts(muabanR), loadMyOrders(muabanR)]);
  }catch(e){
    showRpc(e, "connectWallet");
  }
}
function disconnectWallet(){
  account = null; signer = null;
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

/* -------------------- BỆNH ÁN TX -------------------- */
async function hasPendingTx(){
  const latest = await providerWrite.getTransactionCount(account, "latest");
  const pending= await providerWrite.getTransactionCount(account, "pending");
  return pending > latest;
}
async function ensureVicFunds(gasLimit, gasPriceLike){
  try{
    const bal = await providerWrite.getBalance(account);
    let cost;
    if (gasPriceLike?.gasPrice){
      cost = gasPriceLike.gasPrice.mul(gasLimit);
    }else if (gasPriceLike?.maxFeePerGas){
      cost = gasPriceLike.maxFeePerGas.mul(gasLimit);
    }else{
      // conservative default
      cost = ethers.utils.parseUnits("300","gwei").mul(gasLimit);
    }
    if (bal.lt(cost)){
      const need = Number(ethers.utils.formatEther(cost.sub(bal).abs())).toFixed(6);
      throw new Error(`Số dư VIC không đủ trả phí gas. Thiếu khoảng ${need} VIC.`);
    }
  }catch(e){
    throw e;
  }
}
function gasLimitByKind(kind){
  return (kind==="light")?GAS_LIMIT_LIGHT : (kind==="heavy")?GAS_LIMIT_HEAVY : GAS_LIMIT_MED;
}

/* -------------------- Máy gửi TX bền bỉ -------------------- */
async function sendRobust(to, data, kind="med"){
  const gasLimitBase = gasLimitByKind(kind);

  // 0) Kiểm tra nonce pending
  if (await hasPendingTx()){
    throw new Error("Ví đang có giao dịch đang chờ (pending). Hãy mở MetaMask → Activity → Speed up hoặc Cancel giao dịch cũ, rồi thử lại.");
  }

  // 1) EstimateGas (buffer 30%)
  let estGas = gasLimitBase;
  try{
    const from = account;
    const eg = await providerWrite.estimateGas({ from, to, data });
    estGas = eg.mul(130).div(100);
  }catch(_) {
    // không estimate được → dùng gasLimit mặc định theo kind
  }

  // 2) Thử 3 tầng gửi
  // A) Native path (để MetaMask tự estimate)
  try{
    const tx = await signer.sendTransaction({ to, data, value: 0, gasLimit: estGas });
    return await tx.wait();
  }catch(eA){
    const msg = (eA?.message||"").toLowerCase();
    if (!(eA?.code===-32603 || /underpriced|fee|eip-1559|intrinsic gas|transaction|nonce/i.test(msg))) {
      throw eA; // lỗi khác (user deny, …)
    }
    // tiếp tục kế hoạch B
  }

  // B) Legacy type-0 + gasPrice auto-bump
  for (const g of LEGACY_GAS_STEPS){
    try{
      const ov = { type: 0, gasPrice: ethers.utils.parseUnits(String(g),"gwei"), gasLimit: estGas };
      await ensureVicFunds(estGas, ov);
      const tx = await signer.sendTransaction({ to, data, value: 0, ...ov });
      return await tx.wait();
    }catch(eB){
      const msg = (eB?.message||"").toLowerCase();
      if (!(eB?.code===-32603 || /underpriced|fee cap too low|base fee|eip-1559|replacement/i.test(msg))) {
        throw eB;
      }
      // thử bước gas cao hơn
    }
  }

  // C) EIP-1559
  try{
    const fd = await providerWrite.getFeeData();
    const maxFee = (fd.maxFeePerGas || ethers.utils.parseUnits("50","gwei")).mul(2);
    const maxPrio= (fd.maxPriorityFeePerGas || ethers.utils.parseUnits("2","gwei")).mul(2);
    const ov = { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPrio, gasLimit: estGas };
    await ensureVicFunds(estGas, ov);
    const tx = await signer.sendTransaction({ to, data, value: 0, ...ov });
    return await tx.wait();
  }catch(eC){
    throw eC;
  }
}

/* -------------------- Sản phẩm: load qua event -------------------- */
async function loadAllProducts(muabanR){
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

/* -------------------- Đăng ký -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();

    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      try{
        // dùng path robust
        const data = vin.interface.encodeFunctionData("approve", [MUABAN_ADDR, need]);
        await sendRobust(vin.address, data, "light");
      }catch(e){ showRpc(e, "approve.payRegistration"); return; }
    }

    // simulate
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send robust
    try{
      const data = muaban.interface.encodeFunctionData("payRegistration");
      const { MUABAN_ADDR } = readAddrs();
      await sendRobust(MUABAN_ADDR, data, "med");
    }catch(e){ showRpc(e, "send.payRegistration"); return; }

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "btnRegister.catch"); }
});

/* -------------------- Tạo/Cập nhật sản phẩm -------------------- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Ví chưa đăng ký. Bấm ‘Đăng ký’ trước."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=>hide($("#formCreate")));
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    let name   = ($("#createName").value||"").trim();
    const ipfs   = ($("#createIPFS").value||"").trim();
    const unit   = ($("#createUnit").value||"").trim();
    const wallet = ($("#createWallet").value||"").trim();
    const days   = parseInt(($("#createDays").value||"").trim(), 10);
    const priceVNDNum = parseVND($("#createPrice").value);

    if (name.length > 500) name = name.slice(0,500);
    if (!name || !ipfs || !unit || !wallet){ alert("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ alert("Ví nhận thanh toán không hợp lệ."); return; }
    if (!Number.isInteger(days) || days <= 0){ alert("Số ngày giao ≥ 1."); return; }
    if (!Number.isFinite(priceVNDNum) || priceVNDNum <= 0){ alert("Giá (VND) phải > 0."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(priceVNDNum));

    // simulate
    try{
      const txData = await muaban.populateTransaction.createProduct(
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      );
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){
      alert(parseRevert(simErr));
      return;
    }

    // send robust (raw)
    try{
      const data = muaban.interface.encodeFunctionData("createProduct",[
        name, descriptionCID, imageCID, priceVND, days, wallet, true
      ]);
      const { MUABAN_ADDR } = readAddrs();
      await sendRobust(MUABAN_ADDR, data, "heavy");
    }catch(sendErr){
      showRpc(sendErr, "send.createProduct");
      return;
    }

    alert("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){
    showRpc(e, "submitCreate.catch");
  }
}

$(".modal#formUpdate .close")?.addEventListener("click", ()=>hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND);
  $("#updateDays").value = String(p.deliveryDaysMax);
  $("#updateWallet").value = String(p.payoutWallet);
  $("#updateActive").checked = !!p.active;
  show($("#formUpdate"));
}
async function submitUpdate(){
  try{
    const pid = Number($("#updatePid").value);
    const priceInput = parseVND($("#updatePrice").value);
    const days = parseInt(($("#updateDays").value||"").trim(), 10);
    const wallet = ($("#updateWallet").value||"").trim();
    const active = !!$("#updateActive").checked;

    if (!Number.isFinite(priceInput) || priceInput<=0){ toast("Giá (VND) phải > 0."); return; }
    if (!Number.isInteger(days) || days<=0){ toast("Số ngày giao ≥ 1."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận thanh toán không hợp lệ."); return; }

    // simulate
    try{
      const txData = await muaban.populateTransaction.updateProduct(pid, ethers.BigNumber.from(String(priceInput)), days, wallet, active);
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ toast(parseRevert(simErr)); return; }

    // send robust (raw)
    try{
      const data = muaban.interface.encodeFunctionData("updateProduct",[pid, ethers.BigNumber.from(String(priceInput)), days, wallet, active]);
      const { MUABAN_ADDR } = readAddrs();
      await sendRobust(MUABAN_ADDR, data, "med");
    }catch(e){ showRpc(e, "send.updateProduct"); return; }

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    const { muabanR } = initContractsForRead();
    await loadAllProducts(muabanR);
  }catch(e){ showRpc(e, "submitUpdate.catch"); }
}

/* -------------------- Mua hàng & Đơn hàng -------------------- */
$(".modal#formBuy .close")?.addEventListener("click", ()=>hide($("#formBuy")));
$("#btnSubmitBuy")?.addEventListener("click", submitBuy);
$("#buyQty")?.addEventListener("input", recalcBuyTotal);

let currentBuying = null;
function openBuyForm(pid, p){
  currentBuying = { pid, product: p };
  $("#buyProductInfo").innerHTML = `
    <div class="order-row">
      <span class="order-strong">${escapeHtml(p.name)}</span>
      <span class="badge mono">#${pid}</span>
    </div>
    <div class="order-row">
      Giá: <span class="order-strong">${Number(p.priceVND).toLocaleString('vi-VN')} VND</span>
      · Giao tối đa ${p.deliveryDaysMax} ngày
    </div>`;
  $("#buyName").value=""; $("#buyAddress").value="";
  $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyQty").value=1;
  recalcBuyTotal();
  show($("#formBuy"));
}
function recalcBuyTotal(){
  try{
    if (!currentBuying) return;
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const totalVND = ethers.BigNumber.from(String(currentBuying.product.priceVND)).mul(qty);
    const vinAmt = totalVND.mul(vinPerVNDWei);
    const txt = Number(ethers.utils.formatUnits(vinAmt,18)).toLocaleString("en-US",{maximumFractionDigits:6});
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ${txt} VIN`;
  }catch(_){
    $("#buyTotalVIN").textContent = `Tổng VIN cần trả: ...`;
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
        const data = vin.interface.encodeFunctionData("approve", [MUABAN_ADDR, vinAmount]);
        await sendRobust(vin.address, data, "light");
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
      const data = muaban.interface.encodeFunctionData("placeOrder",[pid, qty, vinPerVNDWei, cipher]);
      await sendRobust(readAddrs().MUABAN_ADDR, data, "med");
    }catch(e){ showRpc(e, "send.placeOrder"); return; }

    hide($("#formBuy"));
    toast("Đặt mua thành công.");
    const { muabanR } = initContractsForRead();
    await loadMyOrders(muabanR);
  }catch(e){ showRpc(e, "submitBuy.catch"); }
}

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
      const data = muaban.interface.encodeFunctionData("confirmReceipt",[orderId]);
      await sendRobust(readAddrs().MUABAN_ADDR, data, "light");
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
      const data = muaban.interface.encodeFunctionData("refundIfExpired",[orderId]);
      await sendRobust(readAddrs().MUABAN_ADDR, data, "light");
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
