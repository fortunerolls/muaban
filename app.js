/* ====================================================================
   muaban.vin — app.js (ethers v5)
   Fix triệt để “Internal JSON-RPC error” khi gửi tx:
   - Ước lượng gas động (estimateGas) + đệm 40%
   - KHÔNG set type/chainId trong overrides (tránh RPC -32603)
   - Kiểm tra đủ VIC trả gas trước khi gửi
   - Preflight (eth_call) để thấy reason rõ ràng
==================================================================== */

/* -------------------- DOM helpers -------------------- */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(!el) return; el.classList.remove('hidden'); };
const hide = el=>{ if(!el) return; el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`: "";

/* -------------------- Config -------------------- */
const CFG = {
  CHAIN_ID_DEC: 88,
  CHAIN_ID_HEX: "0x58",
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",

  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",

  // gas price tối thiểu nếu getGasPrice lỗi
  GAS_PRICE_GWEI_FALLBACK: "50",

  // Nguồn tỷ giá VIN/VND
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

/* -------------------- State -------------------- */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR;  // read
let muaban,  vin;   // write
let isRegistered = false;

let vinVND = 0; // 1 VIN = ? VND
let vinPerVNDWei = ethers.BigNumber.from(0); // wei VIN per 1 VND (ceil)
let vinDecimals = 18;

let productsCache = []; // [{pid, data}]
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
}
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(CFG.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  muabanR = new ethers.Contract(CFG.MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(CFG.VIN_ADDR,    VIN_ABI,    providerRead);
}
function initContractsForWrite(){
  muaban = new ethers.Contract(CFG.MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(CFG.VIN_ADDR,    VIN_ABI,    signer);
}

/* -------------------- Network Helpers -------------------- */
async function ensureViction(){
  const eth = window.ethereum;
  if (!eth) return;
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId === CFG.CHAIN_ID_HEX) return;
  try{
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CFG.CHAIN_ID_HEX }] });
  }catch(err){
    if (err && err.code === 4902){
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: CFG.CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name: "VIC", symbol: "VIC", decimals: 18 },
          rpcUrls: [CFG.RPC_URL],
          blockExplorerUrls: [CFG.EXPLORER]
        }]
      });
    }else{
      throw err;
    }
  }
}

/* -------------------- Gas/Override helpers -------------------- */
// Lấy gasPrice an toàn
async function getSafeGasPrice(){
  try{
    const gp = await providerWrite.getGasPrice();
    // nếu RPC trả quá thấp, dùng max(gp, fallback)
    const min = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI_FALLBACK, "gwei");
    return gp.lt(min) ? min : gp;
  }catch(_){
    return ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI_FALLBACK, "gwei");
  }
}
// Ước lượng gas + đệm 40%, KHÔNG set type/chainId
async function buildOv(estimator, args = []){
  const gasPrice = await getSafeGasPrice();
  const est = await estimator(...args);
  const gasLimit = est.mul(140).div(100); // +40%
  return { gasPrice, gasLimit };
}
// Kiểm tra đủ VIC trả gas trước khi gửi
async function assertHasGasBudget(ov){
  const bal = await providerWrite.getBalance(account);
  const fee = ov.gasPrice.mul(ov.gasLimit);
  if (bal.lt(fee)){
    throw new Error(`Insufficient VIC for gas. Need ≈ ${ethers.utils.formatEther(fee)} VIC, balance = ${ethers.utils.formatEther(bal)} VIC`);
  }
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
    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from(10).pow(vinDecimals);
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.warn("fetchVinToVND:", e);
    $("#vinPrice")?.replaceChildren("Loading price...");
  }
}

/* -------------------- Kết nối/Ngắt ví -------------------- */
async function connectWallet(){
  try{
    if (!window.ethereum){ alert("Vui lòng cài MetaMask."); return; }
    await ensureViction();
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==CFG.CHAIN_ID_DEC){ alert("Sai mạng. Hãy chọn Viction Mainnet."); return; }
    signer  = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();
    initContractsForWrite();

    // decimals VIN (an toàn)
    try { vinDecimals = await (new ethers.Contract(CFG.VIN_ADDR, VIN_ABI, providerRead)).decimals(); }
    catch(_){ try { vinDecimals = await muabanR.vinDecimals(); } catch(_){} }

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    isRegistered = Boolean(reg);

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${CFG.EXPLORER}/address/${account}`;
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal, vinDecimals)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;

    refreshMenu();
    await Promise.all([fetchVinToVND(), loadAllProducts(), loadMyOrders()]);
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account=null; signer=null; muaban=null; vin=null;
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

/* -------------------- Đăng ký (payRegistration) -------------------- */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }
  try{
    const regFee = await muabanR.REG_FEE();

    // ensure allowance
    const allow = await vin.allowance(account, CFG.MUABAN_ADDR);
    if (allow.lt(regFee)){
      const ovA = await buildOv(vin.estimateGas.approve, [CFG.MUABAN_ADDR, regFee]);
      await assertHasGasBudget(ovA);
      const txA = await vin.approve(CFG.MUABAN_ADDR, regFee, ovA);
      await txA.wait();
    }

    // preflight
    const callData = await muaban.populateTransaction.payRegistration();
    callData.from = account;
    await providerWrite.call(callData);

    // send
    const ov = await buildOv(muaban.estimateGas.payRegistration, []);
    await assertHasGasBudget(ov);
    const tx = await muaban.payRegistration(ov);
    await tx.wait();

    isRegistered = true;
    alert("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "payRegistration.send"); }
});

/* -------------------- Sản phẩm -------------------- */
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({ address: CFG.MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const ids = new Set();
    for (const l of logs){
      const parsed = iface.parseLog(l);
      ids.add(parsed.args.productId.toString());
    }

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
  const list = productsCache.filter(({data})=> (data.name||"").toLowerCase().includes(q));
  renderProducts(list);
});

/* ----- Đăng sản phẩm ----- */
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
  if (!isRegistered){ alert("Ví chưa đăng ký."); return; }

  const name   = ($("#createName").value||"").trim();
  const imgCID = ($("#createIPFS").value||"").trim();
  const unit   = ($("#createUnit").value||"").trim();
  const priceVND = parseVND($("#createPrice").value);
  const payout  = ($("#createWallet").value||"").trim();
  const days    = Number($("#createDays").value||"0");

  if (!name){ alert("Nhập tên sản phẩm."); return; }
  if (!priceVND || priceVND<=0){ alert("Giá bán (VND) phải > 0."); return; }
  if (!ethers.utils.isAddress(payout)){ alert("Ví nhận thanh toán không hợp lệ."); return; }
  if (!(days>0)){ alert("Thời gian giao hàng (ngày) phải ≥ 1."); return; }

  const descCID = `unit:${unit||""}`;
  try{
    // preflight
    const callData = await muaban.populateTransaction.createProduct(
      name, descCID, imgCID, ethers.BigNumber.from(priceVND),
      days, payout, true
    );
    callData.from = account;
    await providerWrite.call(callData);

    // send (estimate + pad + kiểm tra gas)
    const args = [name, descCID, imgCID, ethers.BigNumber.from(priceVND), days, payout, true];
    const ov   = await buildOv(muaban.estimateGas.createProduct, args);
    await assertHasGasBudget(ov);
    const tx   = await muaban.createProduct(...args, ov);
    await tx.wait();

    hide($("#formCreate"));
    alert("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "createProduct.send"); }
});

/* ----- Cập nhật sản phẩm ----- */
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
    const callData = await muaban.populateTransaction.updateProduct(
      pid, ethers.BigNumber.from(price), days, payout, active
    );
    callData.from = account;
    await providerWrite.call(callData);

    const args = [pid, ethers.BigNumber.from(price), days, payout, active];
    const ov   = await buildOv(muaban.estimateGas.updateProduct, args);
    await assertHasGasBudget(ov);
    const tx   = await muaban.updateProduct(...args, ov);
    await tx.wait();

    hide($("#formUpdate"));
    alert("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "updateProduct.send"); }
});

/* -------------------- Mua hàng (placeOrder) -------------------- */
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
    const totalVIN = totalVND / vinVND;
    $("#buyTotalVIN").textContent = `≈ ${totalVIN.toFixed(6)} VIN`;
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
  const raw = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(raw))); // placeholder base64
}

$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ alert("Hãy kết nối ví."); return; }
  if (!isRegistered){ alert("Ví chưa đăng ký."); return; }
  if (vinPerVNDWei.isZero()){ alert("Tỷ giá chưa sẵn sàng."); return; }

  const pid = Number($("#buyProductInfo")?.dataset?.pid || "0");
  const qty = Math.max(1, Number($("#buyQty").value||"0"));
  if (!(pid>0)) { alert("Thiếu mã sản phẩm."); return; }
  const cipher = packBuyerInfoCipher();

  try{
    // Simulate để bắt reason sớm
    const callData = await muaban.populateTransaction.placeOrder(
      pid, qty, vinPerVNDWei, cipher
    );
    callData.from = account;
    await providerWrite.call(callData);

    // Ước lượng VIN cần để approve
    const prod = await muabanR.getProduct(pid);
    const totalVND = ethers.BigNumber.from(prod.priceVND).mul(qty);
    const estVinWei = totalVND.mul(vinPerVNDWei); // wei
    const approveNeeded = estVinWei.mul(101).div(100); // +1%

    // ensure allowance
    const allow = await vin.allowance(account, CFG.MUABAN_ADDR);
    if (allow.lt(approveNeeded)){
      const ovA = await buildOv(vin.estimateGas.approve, [CFG.MUABAN_ADDR, approveNeeded]);
      await assertHasGasBudget(ovA);
      const txA = await vin.approve(CFG.MUABAN_ADDR, approveNeeded, ovA);
      await txA.wait();
    }

    // send placeOrder
    const args = [pid, qty, vinPerVNDWei, cipher];
    const ov   = await buildOv(muaban.estimateGas.placeOrder, args);
    await assertHasGasBudget(ov);
    const tx   = await muaban.placeOrder(...args, ov);
    await tx.wait();

    hide($("#formBuy"));
    alert("Đặt hàng thành công.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "placeOrder.send"); }
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
  }catch(e){ console.error("loadMyOrders:", e); }
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
    const callData = await muaban.populateTransaction.confirmReceipt(oid);
    callData.from = account;
    await providerWrite.call(callData);

    const ov = await buildOv(muaban.estimateGas.confirmReceipt, [oid]);
    await assertHasGasBudget(ov);
    const tx = await muaban.confirmReceipt(oid, ov);
    await tx.wait();

    alert("Đã xác nhận nhận hàng. Hệ thống giải ngân cho người bán.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "confirmReceipt.send"); }
}

async function refundIfExpired(oid){
  if (!account){ alert("Hãy kết nối ví."); return; }
  try{
    const callData = await muaban.populateTransaction.refundIfExpired(oid);
    callData.from = account;
    await providerWrite.call(callData);

    const ov = await buildOv(muaban.estimateGas.refundIfExpired, [oid]);
    await assertHasGasBudget(ov);
    const tx = await muaban.refundIfExpired(oid, ov);
    await tx.wait();

    alert("Hoàn tiền thành công (nếu đã quá hạn).");
    await loadMyOrders();
  }catch(e){ showRpc(e, "refundIfExpired.send"); }
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
    initContractsForRead();
    try { // lấy decimals VIN trước khi tính tỷ giá
      const vinTmp = new ethers.Contract(CFG.VIN_ADDR, VIN_ABI, providerRead);
      vinDecimals = await vinTmp.decimals();
    } catch(_) {
      try { vinDecimals = await muabanR.vinDecimals(); } catch(_){}
    }
    fetchVinToVND();
    await loadAllProducts();
  }catch(e){ console.error(e); }
})();
