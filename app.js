/* ====================================================================
   muaban.vin — app.js (ethers v5) — RAW TX SENDER EDITION
   Mục tiêu: dứt điểm lỗi -32603 ("Internal JSON-RPC error") khi gửi tx
   Cách làm:
   - Encode data (iface.encodeFunctionData) cho từng hàm
   - Simulate bằng provider.call({from,to,data,value}) để thấy reason
   - estimateGas cho {from,to,data,value} rồi đệm +40%
   - Chỉ set gasPrice + gasLimit (không set type/eip-1559)
   - signer.sendTransaction({from,to,data,value,gasPrice,gasLimit})
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";

/* -------------------- Config -------------------- */
const CFG = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  GAS_PRICE_MIN_GWEI: "50", // có thể nâng lên 100–200 khi mạng bận

  // tỷ giá VIN/VND
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR;                    // read contracts
let muabanIF, vinIF;                  // interfaces for encoding
let isRegistered = false;

let vinVND = 0;
let vinPerVNDWei = ethers.BigNumber.from(0);
let vinDecimals = 18;

let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

/* -------------------- Utils -------------------- */
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[s] || s));
}
function ipfsToHttp(link){
  if (!link) return "";
  if (link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/" + link.slice(7);
  return link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function parseVND(input){
  const digits = String(input||"").replace(/[^\d]/g,"");
  if (!digits) return NaN;
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}
function statusText(code){
  const m = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
  return m[Number(code)] || "-";
}
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Ngày giao phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không hợp lệ.",
    NOT_SELLER: "Bạn không phải người bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thao tác.",
    NOT_EXPIRED: "Chưa quá hạn giao hàng."
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
function showRpc(err, tag="RPC"){
  try{
    const obj = {
      tag,
      code: err?.code,
      message: err?.message || err?.error?.message,
      data: err?.data || err?.error?.data,
      reason: err?.reason
    };
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj,null,2)}`);
  }catch(_){
    console.error(tag, err);
    alert(`${tag}: ${String(err)}`);
  }
}

/* -------------------- ABI / Providers / Contracts -------------------- */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());
  muabanIF   = new ethers.utils.Interface(MUABAN_ABI);
  vinIF      = new ethers.utils.Interface(VIN_ABI);
}
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(CFG.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initReadContracts(){
  muabanR = new ethers.Contract(CFG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(CFG.VIN_ADDR,    VIN_ABI,    providerRead);
}

/* -------------------- RAW TX HELPER -------------------- */
async function safeGasPrice(){
  try{
    const gp = await providerWrite.getGasPrice();
    const min = ethers.utils.parseUnits(CFG.GAS_PRICE_MIN_GWEI, "gwei");
    return gp.lt(min) ? min : gp;
  }catch(_){
    return ethers.utils.parseUnits(CFG.GAS_PRICE_MIN_GWEI, "gwei");
  }
}
/**
 * Gửi một giao dịch "thô" với dữ liệu đã encode
 * @param {string} to
 * @param {string} data
 * @param {ethers.BigNumberish} value
 */
async function rawSend(to, data, value = 0){
  const from = account;
  // 1) simulate để thấy reason nếu revert
  await providerWrite.call({ from, to, data, value });
  // 2) estimate gas cho payload thực sự (không dùng overrides kiểu ethers Contract)
  const est = await providerWrite.estimateGas({ from, to, data, value });
  const gasLimit = est.mul(140).div(100); // +40%
  const gasPrice = await safeGasPrice();
  // 3) kiểm tra ngân sách gas (VIC)
  const bal = await providerWrite.getBalance(from);
  const fee = gasPrice.mul(gasLimit);
  if (bal.lt(fee)){
    throw new Error(`Insufficient VIC for gas. Need ≈ ${ethers.utils.formatEther(fee)} VIC, balance = ${ethers.utils.formatEther(bal)} VIC`);
  }
  // 4) gửi tx
  const tx = await signer.sendTransaction({ to, data, value, gasPrice, gasLimit });
  return await tx.wait();
}

/* -------------------- Tỷ giá VIN/VND -------------------- */
async function fetchVinToVND(){
  try{
    let vicVnd = 0;
    try{
      const r = await fetch(CFG.COINGECKO_VIC_VND);
      const j = await r.json();
      vicVnd = Number(j?.viction?.vnd||0);
    }catch(_){}
    if (vicVnd>0){
      vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC
    }else{
      const [r1, r2] = await Promise.all([
        fetch(CFG.COINGECKO_VIC_USD),
        fetch(CFG.COINGECKO_USD_VND)
      ]);
      const vicUsd = Number((await r1.json())?.viction?.usd||0);
      const usdVnd = Number((await r2.json())?.tether?.vnd||0);
      if (vicUsd>0 && usdVnd>0){
        vinVND = Math.floor(vicUsd * 100 * usdVnd);
      }else{
        const [b1, c1] = await Promise.all([
          fetch(CFG.BINANCE_VICUSDT),
          fetch(CFG.COINGECKO_USD_VND)
        ]);
        const vicUsdt = Number((await b1.json())?.price||0);
        const usdVnd2 = Number((await c1.json())?.tether?.vnd||0);
        if (vicUsdt>0 && usdVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdVnd2);
      }
    }
    if (!(vinVND>0)) throw new Error("Không lấy được giá VIN/VND");
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1);
    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.warn("fetchVinToVND:", e);
    $("#vinPrice")?.replaceChildren("Loading price...");
  }
}

/* -------------------- Wallet -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ alert("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==CFG.CHAIN_ID){ alert("Sai mạng. Chọn Viction Mainnet."); return; }
    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    initReadContracts();

    // decimals VIN
    try { vinDecimals = await (new ethers.Contract(CFG.VIN_ADDR, VIN_ABI, providerRead)).decimals(); } catch(_){}

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${CFG.EXPLORER}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal, vinDecimals)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    isRegistered = Boolean(reg);
    refreshMenu();

    await Promise.all([fetchVinToVND(), loadAllProducts(), loadMyOrders()]);
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account=null; signer=null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent = "VIN: 0";
  $("#vicBalance").textContent = "VIC: 0";
  isRegistered=false;
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

/* -------------------- RAW helpers cho contract -------------------- */
function data_payRegistration(){ return muabanIF.encodeFunctionData("payRegistration", []); }
function data_createProduct(name, descCID, imgCID, priceVND, days, payout, active){
  return muabanIF.encodeFunctionData("createProduct", [name, descCID, imgCID, priceVND, days, payout, active]);
}
function data_updateProduct(pid, priceVND, days, payout, active){
  return muabanIF.encodeFunctionData("updateProduct", [pid, priceVND, days, payout, active]);
}
function data_placeOrder(pid, qty, vinPerVND, cipher){
  return muabanIF.encodeFunctionData("placeOrder", [pid, qty, vinPerVND, cipher]);
}
function data_confirmReceipt(oid){
  return muabanIF.encodeFunctionData("confirmReceipt", [oid]);
}
function data_refundIfExpired(oid){
  return muabanIF.encodeFunctionData("refundIfExpired", [oid]);
}
function data_approve(spender, amount){
  return vinIF.encodeFunctionData("approve", [spender, amount]);
}

/* -------------------- Đăng ký (approve đúng spender + rawSend) -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }
  try{
    // Lấy REG_FEE & owner (nếu contract thu phí về owner thay vì contract)
    const [regFee, ownerAddr] = await Promise.all([
      muabanR.REG_FEE ? muabanR.REG_FEE() : ethers.BigNumber.from("1000000000000000"),
      (async ()=>{ try{ return await muabanR.owner(); }catch(_){ return null; }})()
    ]);
    const spenderForReg = ownerAddr && ethers.utils.isAddress(ownerAddr) ? ownerAddr : CFG.MUABAN_ADDR;

    // ensure allowance
    const current = await vinR.allowance(account, spenderForReg);
    if (current.lt(regFee)){
      const data = data_approve(spenderForReg, regFee);
      await rawSend(CFG.VIN_ADDR, data, 0);
    }

    // payRegistration
    const data = data_payRegistration();
    await rawSend(CFG.MUABAN_ADDR, data, 0);

    isRegistered = true;
    alert("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "payRegistration.raw"); }
});

/* -------------------- Sản phẩm -------------------- */
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({ address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const ids = new Set();
    logs.forEach(l => ids.add(iface.parseLog(l).args.productId.toString()));
    productsCache = [];
    for (const pid of Array.from(ids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      productsCache.push({ pid:Number(pid), data:p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){
    wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`;
    return;
  }
  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img  = ipfsToHttp(data.imageCID) || "https://via.placeholder.com/112x90?text=IPFS";
    const active = data.active;
    const price  = Number(data.priceVND);
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
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span>
          <span class="unit">/ ${escapeHtml(unit || 'đv')}</span>
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
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=> openUpdateForm(pid, data));
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=> openBuyForm(pid, data));
    wrap.appendChild(card);
  });
}
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q){ renderProducts(productsCache); return; }
  renderProducts(productsCache.filter(({data})=> (data.name||"").toLowerCase().includes(q)));
});

/* ----- Đăng sản phẩm (RAW TX) ----- */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ alert("Ví chưa đăng ký. Bấm 'Đăng ký' trước."); return; }
  $("#createName").value = "";
  $("#createIPFS").value = "";
  $("#createUnit").value = "";
  $("#createPrice").value = "";
  $("#createWallet").value = account || "";
  $("#createDays").value = "3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));

$("#btnSubmitCreate")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }

  const name   = ($("#createName").value||"").trim();
  const imgCID = ($("#createIPFS").value||"").trim();
  const unit   = ($("#createUnit").value||"").trim();
  const priceVNDNum = parseVND($("#createPrice").value);
  const payout = ($("#createWallet").value||"").trim();
  const days   = Number($("#createDays").value||"0");

  if (!name){ alert("Nhập tên sản phẩm."); return; }
  if (!priceVNDNum || priceVNDNum<=0){ alert("Giá bán (VND) phải > 0."); return; }
  if (!ethers.utils.isAddress(payout)){ alert("Ví nhận thanh toán không hợp lệ."); return; }
  if (!(days>0)){ alert("Ngày giao phải ≥ 1."); return; }

  const descCID = `unit:${unit||""}`;
  const priceVND = ethers.BigNumber.from(String(priceVNDNum));

  try{
    const data = data_createProduct(name, descCID, imgCID, priceVND, days, payout, true);
    await rawSend(CFG.MUABAN_ADDR, data, 0);
    alert("Đăng sản phẩm thành công.");
    hide($("#formCreate"));
    await loadAllProducts();
  }catch(e){ showRpc(e, "createProduct.raw"); }
});

/* ----- Cập nhật sản phẩm (RAW TX) ----- */
function openUpdateForm(pid, p){
  $("#updatePid").value   = String(pid);
  $("#updatePrice").value = String(p.priceVND||"");
  $("#updateDays").value  = String(p.deliveryDaysMax||"");
  $("#updateWallet").value= p.payoutWallet||"";
  $("#updateActive").checked = Boolean(p.active);
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }

  const pid   = Number($("#updatePid").value||"0");
  const price = parseVND($("#updatePrice").value);
  const days  = Number($("#updateDays").value||"0");
  const payout = ($("#updateWallet").value||"").trim();
  const active = !!$("#updateActive").checked;

  if (!(pid>0)){ alert("Thiếu ID sản phẩm."); return; }
  if (!price || price<=0){ alert("Giá bán (VND) phải > 0."); return; }
  if (!(days>0)){ alert("Ngày giao phải ≥ 1."); return; }
  if (!ethers.utils.isAddress(payout)){ alert("Ví nhận thanh toán không hợp lệ."); return; }

  try{
    const data = data_updateProduct(pid, ethers.BigNumber.from(String(price)), days, payout, active);
    await rawSend(CFG.MUABAN_ADDR, data, 0);
    alert("Cập nhật thành công.");
    hide($("#formUpdate"));
    await loadAllProducts();
  }catch(e){ showRpc(e, "updateProduct.raw"); }
});

/* -------------------- Mua hàng (RAW TX) -------------------- */
function openBuyForm(pid, p){
  $("#buyProductInfo").innerHTML = `
    <div><b>${escapeHtml(p.name)}</b> • #${p.productId || pid}</div>
    <div>${Number(p.priceVND).toLocaleString('vi-VN')} VND / ${escapeHtml(parseUnitFromCID(p.descriptionCID) || 'đv')}</div>
  `;
  $("#buyQty").value = "1";
  $("#buyName").value = "";
  $("#buyAddress").value = "";
  $("#buyPhone").value = "";
  $("#buyNote").value = "";
  $("#buyProductInfo").dataset.pid = String(pid);
  updateBuyTotal();
  show($("#formBuy"));
}
$(".modal#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", updateBuyTotal);
function updateBuyTotal(){
  const pid = Number($("#buyProductInfo")?.dataset?.pid || "0");
  const p = productsCache.find(x=>x.pid===pid)?.data;
  if (!p){ $("#buyTotalVIN").textContent = "-"; return; }
  const qty = Math.max(1, Number($("#buyQty").value||"1"));
  const totalVND = Number(p.priceVND) * qty;
  if (vinVND>0){
    $("#buyTotalVIN").textContent = `≈ ${(totalVND / vinVND).toFixed(6)} VIN`;
  }else{
    $("#buyTotalVIN").textContent = "Tỷ giá chưa sẵn sàng…";
  }
}
function packBuyerInfoCipher(){
  const obj = {
    name: ($("#buyName").value||"").trim(),
    addr: ($("#buyAddress").value||"").trim(),
    phone:($("#buyPhone").value||"").trim(),
    note: ($("#buyNote").value||"").trim(),
    ts: Date.now()
  };
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}
$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }
  if (!isRegistered){ alert("Ví chưa đăng ký."); return; }
  if (vinPerVNDWei.isZero()){ alert("Tỷ giá chưa sẵn sàng."); return; }

  const pid = Number($("#buyProductInfo")?.dataset?.pid || "0");
  const qty = Math.max(1, Number($("#buyQty").value||"0"));
  if (!(pid>0)) { alert("Thiếu mã SP."); return; }

  const cipher = packBuyerInfoCipher();

  try{
    // 1) Ước tính VIN cần & ensure allowance cho spender = contract (escrow)
    const prod = await muabanR.getProduct(pid);
    const totalVND = ethers.BigNumber.from(prod.priceVND).mul(qty);
    const vinNeed  = totalVND.mul(vinPerVNDWei); // wei
    const allow = await vinR.allowance(account, CFG.MUABAN_ADDR);
    if (allow.lt(vinNeed)){
      const dataAp = data_approve(CFG.MUABAN_ADDR, vinNeed);
      await rawSend(CFG.VIN_ADDR, dataAp, 0);
    }

    // 2) placeOrder
    const dataPO = data_placeOrder(pid, qty, vinPerVNDWei, cipher);
    await rawSend(CFG.MUABAN_ADDR, dataPO, 0);

    alert("Đặt hàng thành công.");
    hide($("#formBuy"));
    await loadMyOrders();
  }catch(e){ showRpc(e, "placeOrder.raw"); }
});

/* -------------------- Đơn hàng của tôi -------------------- */
async function loadMyOrders(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({ address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    ordersBuyer = [];
    ordersSeller = [];
    for (const l of logs){
      const parsed = iface.parseLog(l);
      const oid = parsed.args.orderId.toString();
      const ord = await muabanR.getOrder(oid);
      if (!ord || !ord.orderId) continue;
      const isB = account && ord.buyer?.toLowerCase()  === account;
      const isS = account && ord.seller?.toLowerCase() === account;
      if (isB) ordersBuyer.push(ord);
      if (isS) ordersSeller.push(ord);
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

  const fmt = (wei)=>parseFloat(ethers.utils.formatUnits(wei, vinDecimals)).toFixed(6);

  for (const o of ordersBuyer){
    const el = document.createElement("div");
    el.className = "order-card";
    el.innerHTML = `
      <div class="order-row"><span class="order-strong">#${o.orderId.toString()}</span> • SP: ${o.productId.toString()} • SL: ${o.quantity.toString()}</div>
      <div class="order-row">VIN escrow: ${fmt(o.vinAmount)} • Trạng thái: ${statusText(o.status)}</div>
      <div class="order-row">Hạn giao: ${new Date(Number(o.deadline)*1000).toLocaleString("vi-VN")}</div>
      <div class="card-actions">
        ${Number(o.status)===1 ? `<button class="btn" data-action="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>` : ""}
        ${Number(o.status)===1 ? `<button class="btn" data-action="refund"  data-oid="${o.orderId}">Hoàn tiền khi quá hạn</button>` : ""}
      </div>
    `;
    el.querySelector('[data-action="confirm"]')?.addEventListener("click", ()=> confirmReceipt(o.orderId));
    el.querySelector('[data-action="refund"]') ?.addEventListener("click", ()=> refundIfExpired(o.orderId));
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
  if (!account){ alert("Hãy kết nối ví."); return; }
  try{
    const data = data_confirmReceipt(oid);
    await rawSend(CFG.MUABAN_ADDR, data, 0);
    alert("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "confirmReceipt.raw"); }
}
async function refundIfExpired(oid){
  if (!account){ alert("Hãy kết nối ví."); return; }
  try{
    const data = data_refundIfExpired(oid);
    await rawSend(CFG.MUABAN_ADDR, data, 0);
    alert("Hoàn tiền (nếu đã quá hạn) thành công.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "refundIfExpired.raw"); }
}

/* -------------------- Header/Menu actions -------------------- */
$("#btnConnect")   ?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);
$("#btnOrdersBuy") ?.addEventListener("click", ()=>{ show($("#ordersBuySection")); hide($("#ordersSellSection")); });
$("#btnOrdersSell")?.addEventListener("click", ()=>{ show($("#ordersSellSection")); hide($("#ordersBuySection")); });

/* -------------------- Bootstrap -------------------- */
(async function main(){
  try{
    await loadAbis();
    initProviders();
    initReadContracts();
    fetchVinToVND();
    await loadAllProducts();
  }catch(e){ console.error(e); }
})();
