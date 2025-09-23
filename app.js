<!-- app.js (drop-in replacement) -->
<script>
// ======================= Helpers =======================
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(el) el.classList.remove('hidden'); };
const hide = el=>{ if(el) el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast=(m)=>alert(m);
const esc =(s)=>String(s).replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;" }[c]));

function parseVND(v){ const n=Number(String(v||"").replace(/[^\d]/g,"")); return Number.isFinite(n) && n>0 ? n : NaN; }
function ipfsToHttp(link){ if(!link) return ""; if(link.startsWith("ipfs://")) return "https://ipfs.io/ipfs/"+link.slice(7); return link; }
function parseUnitFromCID(desc){ const m=/^unit:(.+)$/i.exec(String(desc||"").trim()); return m?m[1].trim():""; }

// Bóc tách revert reason cho các lỗi “Internal JSON-RPC error”
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  // Map thông điệp phổ biến theo hợp đồng
  const map = {
    NOT_REGISTERED:"Ví chưa đăng ký. Bấm 'Đăng ký' trước.",
    ALREADY_REGISTERED:"Ví đã đăng ký.",
    PRICE_REQUIRED:"Giá VND phải > 0.",
    DELIVERY_REQUIRED:"Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO:"Ví nhận thanh toán không hợp lệ.",
    NOT_SELLER:"Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE:"Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND:"Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED:"Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED:"Tỷ giá VIN/VND chưa sẵn sàng.",
    VIN_TRANSFER_FAIL:"Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED:"Trạng thái đơn không hợp lệ.",
    NOT_BUYER:"Chỉ người mua mới thao tác được.",
    NOT_EXPIRED:"Đơn chưa quá hạn để hoàn tiền."
  };
  for (const k in map){ if(raw.includes(k)) return map[k]; }
  const m=/execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  return m?m[1]: (raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.");
}
function showRpc(err, tag="RPC"){
  try{
    const obj={tag, code:err?.code, message:err?.message||err?.error?.message, data:err?.data||err?.error?.data, reason:err?.reason};
    console.error(tag, obj);
    alert(`${tag}\n${JSON.stringify(obj,null,2)}`);
  }catch(_){ console.error(tag, err); alert(`${tag}: ${String(err)}`); }
}

// ======================= Config =======================
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  // Địa chỉ theo mô tả/ABI bạn cung cấp
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0", // MuabanVND (VIC) :contentReference[oaicite:5]{index=5}
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4", // VIN token (VIC) :contentReference[oaicite:6]{index=6}
  REG_FEE_WEI: "1000000000000000", // 0.001 VIN, theo contract REG_FEE :contentReference[oaicite:7]{index=7}
  // Nguồn giá
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT"
};

// GAS legacy cố định (tránh EIP-1559)
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000"); // approve/confirm/refund
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000"); // payRegistration/update/placeOrder
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000"); // createProduct
const LEGACY_GAS_PRICE_GWEI = "50"; // có thể tăng nếu cần

// ======================= State =======================
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR, muaban, vin;
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei cho 1 VND (ceil)
let vinVND = 0;                               // 1 VIN = ? VND
let productsCache = [];
let ordersBuyer = [];
let ordersSeller = [];

// ======================= ABI & Providers =======================
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json()); // :contentReference[oaicite:8]{index=8}
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json()); // :contentReference[oaicite:9]{index=9}
}
function readAddrs(){
  const b=document.body;
  return {
    MUABAN_ADDR: (b?.dataset?.muabanAddr && ethers.utils.isAddress(b.dataset.muabanAddr)) ? b.dataset.muabanAddr : DEFAULTS.MUABAN_ADDR,
    VIN_ADDR: (b?.dataset?.vinAddr && ethers.utils.isAddress(b.dataset.vinAddr)) ? b.dataset.vinAddr : DEFAULTS.VIN_ADDR
  };
}
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");
}
function initContractsForRead(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muabanR = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(VIN_ADDR, VIN_ABI, providerRead);
}
function initContractsForWrite(){
  const { MUABAN_ADDR, VIN_ADDR } = readAddrs();
  muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
  vin    = new ethers.Contract(VIN_ADDR, VIN_ABI, signer);
}

// ======================= VIN/VND price =======================
function bodyVinVndOverride(){
  const raw = document.body?.dataset?.vinVnd; const n=Number(raw);
  return Number.isFinite(n)&&n>0 ? Math.floor(n) : 0;
}
async function fetchVinToVND(){
  try{
    const override = bodyVinVndOverride();
    if (override>0){ vinVND = override; }
    else{
      // 1) Lấy VIC→VND trực tiếp
      let vicVnd=0;
      try{
        const r=await fetch(DEFAULTS.COINGECKO_VIC_VND);
        const j=await r.json();
        vicVnd = Number(j?.viction?.vnd||0);
      }catch(_){}
      if (vicVnd>0){
        vinVND = Math.floor(vicVnd * 100); // 1 VIN = 100 VIC (theo mô tả) :contentReference[oaicite:10]{index=10}
      }else{
        // 2) VIC→USD × USDT→VND
        const [vicUsdRes, usdtVndRes] = await Promise.all([
          fetch(DEFAULTS.COINGECKO_VIC_USD),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsd = Number((await vicUsdRes.json())?.viction?.usd||0);
        const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd||0);
        if (vicUsd>0 && usdtVnd>0) vinVND = Math.floor(vicUsd * 100 * usdtVnd);
        else{
          // 3) Binance VIC/USDT × USDT/VND
          const [vicUsdtRes, usdtVndRes2] = await Promise.all([
            fetch(DEFAULTS.BINANCE_VICUSDT),
            fetch(DEFAULTS.COINGECKO_USD_VND)
          ]);
          const vicUsdt = Number((await vicUsdtRes.json())?.price||0);
          const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
          if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
        }
      }
    }
    if (!(vinVND>0)) throw new Error("no-price");
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil
    $("#vinPrice")?.replaceChildren(`1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`);
  }catch(e){
    console.warn("fetchVinToVND:", e);
    if (vinPerVNDWei.isZero()) $("#vinPrice")?.replaceChildren("Loading price...");
  }
}

// ======================= Wallet =======================
async function connectWallet(){
  try{
    if(!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Hãy chọn Viction (chainId=88)."); return; }
    signer  = providerWrite.getSigner();
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
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account=null; signer=null; muaban=null; vin=null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent="VIN: 0"; $("#vicBalance").textContent="VIC: 0";
  isRegistered=false; refreshMenu();
}
function refreshMenu(){
  const btnReg=$("#btnRegister"), btnC=$("#btnCreate"), btnOB=$("#btnOrdersBuy"), btnOS=$("#btnOrdersSell");
  const menu=$("#menuBox");
  if(!account){
    btnReg?.classList.remove('hidden'); btnReg && (btnReg.disabled=true);
    btnC?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
    return;
  }
  if(!isRegistered){
    btnReg?.classList.remove('hidden'); btnReg && (btnReg.disabled=false);
    btnC?.classList.add('hidden'); btnOB?.classList.add('hidden'); btnOS?.classList.add('hidden');
  }else{
    btnReg?.classList.add('hidden');
    btnC?.classList.remove('hidden'); btnOB?.classList.remove('hidden'); btnOS?.classList.remove('hidden');
  }
  menu?.classList.remove('hidden');
}
$("#btnConnect")?.addEventListener("click", connectWallet);
$("#btnDisconnect")?.addEventListener("click", disconnectWallet);

// ======================= Legacy gas overrides =======================
function legacyOverrides(kind="med"){
  const ov={ type:0, gasPrice: ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI,"gwei") };
  ov.gasLimit = (kind==="light")?GAS_LIMIT_LIGHT : (kind==="heavy")?GAS_LIMIT_HEAVY : GAS_LIMIT_MED;
  return ov;
}

// ======================= Products (read) =======================
async function loadAllProducts(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated"); // :contentReference[oaicite:11]{index=11}
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, topics:[topic], fromBlock:0, toBlock:"latest" });
    const ids = new Set();
    for(const l of logs){ const p=iface.parseLog(l); ids.add(p.args.productId.toString()); }
    const arr = Array.from(ids).sort((a,b)=>Number(a)-Number(b));
    productsCache=[];
    for(const pid of arr){
      const p = await muabanR.getProduct(pid); // view :contentReference[oaicite:12]{index=12}
      productsCache.push({ pid:Number(pid), data:p });
    }
    renderProducts(productsCache);
  }catch(e){ console.error("loadAllProducts:", e); }
}
function renderProducts(list){
  const wrap=$("#productList"); if(!wrap) return;
  wrap.innerHTML="";
  if(!list.length){ wrap.innerHTML=`<div class="tag">Chưa có sản phẩm.</div>`; return; }
  for(const {pid,data} of list){
    const unit=parseUnitFromCID(data.descriptionCID);
    const img=ipfsToHttp(data.imageCID);
    const active=data.active;
    const price=Number(data.priceVND);
    const card=document.createElement("div");
    card.className="product-card";
    card.innerHTML=`
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'" />
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${esc(data.name)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString('vi-VN')} VND</span> <span class="unit">/ ${esc(unit||'đv')}</span>
        </div>
        <div>
          <span class="stock-badge ${active?'':'out'}">${active?'Còn hàng':'Hết hàng'}</span>
          <span class="tag mono" title="${data.payoutWallet}">Người bán: ${short(data.seller)}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions">
          ${
            !account ? "" :
            (String(data.seller).toLowerCase()===String(account).toLowerCase()
              ? `<button class="btn" data-action="update" data-pid="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && active ? `<button class="btn primary" data-action="buy" data-pid="${pid}">Mua</button>` : ""))
          }
        </div>
      </div>`;
    card.querySelector('[data-action="buy"]')?.addEventListener("click", ()=>openBuyForm(pid, data));
    card.querySelector('[data-action="update"]')?.addEventListener("click", ()=>openUpdateForm(pid, data));
    wrap.appendChild(card);
  }
}
$("#btnSearch")?.addEventListener("click", ()=>{
  const q=($("#searchInput")?.value||"").trim().toLowerCase();
  if(!q) return renderProducts(productsCache);
  renderProducts(productsCache.filter(({data})=> String(data.name).toLowerCase().includes(q)));
});

// ======================= Registration =======================
$("#btnRegister")?.addEventListener("click", async ()=>{
  if(!account){ toast("Hãy kết nối ví."); return; }
  try{
    // ensure allowance 0.001 VIN cho owner (trong payRegistration chuyển VIN -> owner) :contentReference[oaicite:13]{index=13}
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const ownerAddr = await muabanR.owner(); // dùng để hiển thị/kiểm tra nếu cần :contentReference[oaicite:14]{index=14}
    const allow = await vin.allowance(account, ownerAddr);
    if(allow.lt(need)){
      const txA = await vin.approve(ownerAddr, need, legacyOverrides("light"));
      await txA.wait();
    }

    // preflight simulate
    try{
      const txData = await muaban.populateTransaction.payRegistration();
      txData.from = account;
      await providerWrite.call(txData);
    }catch(simErr){ return toast(parseRevert(simErr)); }

    const tx = await muaban.payRegistration(legacyOverrides("med")); // :contentReference[oaicite:15]{index=15}
    await tx.wait();
    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ showRpc(e, "payRegistration"); }
});

// ======================= Create / Update Product =======================
// Open create form
$("#btnCreate")?.addEventListener("click", ()=>{
  if(!isRegistered){ toast("Ví chưa đăng ký."); return; }
  $("#createName").value="";
  $("#createIPFS").value="";
  $("#createUnit").value="";
  $("#createPrice").value="";
  $("#createWallet").value=account||"";
  $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));

async function submitCreate(){
  try{
    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const priceVND = parseVND($("#createPrice").value);
    const payout = ($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);

    if(!name || name.length>500){ toast("Tên sản phẩm không hợp lệ."); return; }
    if(!ipfs){ toast("Thiếu link IPFS hình/video."); return; }
    if(!unit){ toast("Thiếu đơn vị tính."); return; }
    if(!Number.isFinite(priceVND) || priceVND<=0){ toast("Giá VND không hợp lệ."); return; }
    if(!ethers.utils.isAddress(payout)){ toast("Ví nhận thanh toán không hợp lệ."); return; }
    if(!(days>0)){ toast("Ngày giao hàng phải ≥ 1."); return; }
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const active = true;

    // preflight simulate createProduct(...) :contentReference[oaicite:16]{index=16}
    const txData = await muaban.populateTransaction.createProduct(
      name, descriptionCID, imageCID, priceVND, days, payout, active
    );
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ return toast(parseRevert(simErr)); }

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, days, payout, active,
      legacyOverrides("heavy")
    );
    await tx.wait();
    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "submitCreate"); }
}
$("#btnSubmitCreate")?.addEventListener("click", submitCreate);

// Open update form
function openUpdateForm(pid, data){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(data.priceVND||"");
  $("#updateDays").value = String(data.deliveryDaysMax||"");
  $("#updateWallet").value = String(data.payoutWallet||"");
  $("#updateActive").checked = Boolean(data.active);
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));

async function submitUpdate(){
  try{
    const pid = Number($("#updatePid").value||0);
    const priceVND = parseVND($("#updatePrice").value);
    const days = Number($("#updateDays").value||0);
    const payout = ($("#updateWallet").value||"").trim();
    const active = Boolean($("#updateActive").checked);

    if(!(pid>0)) return toast("PID không hợp lệ.");
    if(!Number.isFinite(priceVND) || priceVND<=0){ toast("Giá VND không hợp lệ."); return; }
    if(!(days>0)){ toast("Ngày giao hàng phải ≥ 1."); return; }
    if(!ethers.utils.isAddress(payout)){ toast("Ví nhận thanh toán không hợp lệ."); return; }

    const txData = await muaban.populateTransaction.updateProduct(pid, priceVND, days, payout, active); // :contentReference[oaicite:17]{index=17}
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ return toast(parseRevert(simErr)); }

    const tx = await muaban.updateProduct(pid, priceVND, days, payout, active, legacyOverrides("med"));
    await tx.wait();
    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){ showRpc(e, "submitUpdate"); }
}
$("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

// ======================= Buy / Orders =======================
// Mua: open form (theo mô tả UI) :contentReference[oaicite:18]{index=18}
function openBuyForm(pid, data){
  // formBuy id/fields theo index.html (phần còn lại của form trong file của bạn)
  // Nếu formBuy chưa tồn tại trong HTML của bạn, tạo nhanh modal tối giản:
  let modal=$("#formBuy");
  if(!modal){
    modal=document.createElement("section");
    modal.id="formBuy"; modal.className="modal";
    modal.innerHTML=`
      <div class="modal-content">
        <h2>Đặt mua</h2>
        <input id="buyPid" type="hidden" />
        <label>Số lượng <input id="buyQty" type="number" min="1" value="1"/></label>
        <label>Họ tên <input id="buyName"/></label>
        <label>Địa chỉ <input id="buyAddr"/></label>
        <label>SĐT <input id="buyPhone"/></label>
        <label>Phụ ghi <input id="buyNote"/></label>
        <div class="total-vin" id="buyTotal">Tổng: … VIN</div>
        <div class="actions">
          <button id="btnSubmitBuy" class="btn primary">Xác nhận mua</button>
          <button class="btn close">Đóng</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector(".close").addEventListener("click", ()=> hide($("#formBuy")));
    modal.querySelector("#btnSubmitBuy").addEventListener("click", submitBuy);
    $("#buyQty").addEventListener("input", updateBuyTotal);
  }
  $("#buyPid").value=String(pid);
  $("#buyName").value=""; $("#buyAddr").value=""; $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyQty").value="1";
  $("#formBuy").dataset.priceVND = String(Number(data.priceVND||0));
  updateBuyTotal();
  show($("#formBuy"));
}
function updateBuyTotal(){
  const priceVND = Number($("#formBuy").dataset.priceVND||0);
  const qty = Math.max(1, Number($("#buyQty").value||1));
  const totalVND = priceVND * qty;
  if (vinPerVNDWei.isZero()){
    $("#buyTotal").textContent = `Tổng: đang tải tỷ giá…`;
  }else{
    const totalWei = ethers.BigNumber.from(totalVND.toString()).mul(vinPerVNDWei);
    $("#buyTotal").textContent = `Tổng: ${ethers.utils.formatUnits(totalWei,18)} VIN`;
  }
}
function packBuyerInfoCipher(name, addr, phone, note){
  // Client-side pseudo “mã hóa” tối giản (placeholder): base64 JSON
  const obj = { name, addr, phone, note };
  try{ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  catch(_){ return ""; }
}

async function submitBuy(){
  try{
    if(!isRegistered) return toast("Ví chưa đăng ký.");
    const pid = Number($("#buyPid").value||0);
    const qty = Math.max(1, Number($("#buyQty").value||1));
    const name=($("#buyName").value||"").trim();
    const addr=($("#buyAddr").value||"").trim();
    const phone=($("#buyPhone").value||"").trim();
    const note=($("#buyNote").value||"").trim();

    if(!(pid>0)) return toast("PID không hợp lệ.");
    if(!name||!addr||!phone) return toast("Vui lòng nhập đủ thông tin người nhận.");
    if (vinPerVNDWei.isZero()) return toast("Tỷ giá VIN/VND chưa sẵn sàng. Thử lại sau.");

    // Lấy product để tính VIN cần trả
    const p = await muabanR.getProduct(pid); // :contentReference[oaicite:19]{index=19}
    if(!p.active) return toast("Sản phẩm đang tắt bán.");
    const totalVND = ethers.BigNumber.from(p.priceVND).mul(qty);
    const vinNeed  = totalVND.mul(vinPerVNDWei); // ceil đã tính từ trước

    // ensure allowance buyer -> contract
    const { MUABAN_ADDR } = readAddrs();
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(vinNeed)){
      const txA = await vin.approve(MUABAN_ADDR, vinNeed, legacyOverrides("light")); // approve VIN cho hợp đồng
      await txA.wait();
    }

    const cipher = packBuyerInfoCipher(name, addr, phone, note);

    // preflight simulate placeOrder(pid, qty, vinPerVNDWei, cipher) :contentReference[oaicite:20]{index=20}
    const txData = await muaban.populateTransaction.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher);
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ return toast(parseRevert(simErr)); }

    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), cipher, legacyOverrides("med"));
    await tx.wait();
    hide($("#formBuy"));
    toast("Đặt mua thành công.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "submitBuy"); }
}

// ======================= Orders (buyer/seller views) =======================
$("#btnOrdersBuy")?.addEventListener("click", ()=>{
  show($("#ordersBuySection")); hide($("#ordersSellSection"));
});
$("#btnOrdersSell")?.addEventListener("click", ()=>{
  hide($("#ordersBuySection")); show($("#ordersSellSection"));
});

async function loadMyOrders(){
  try{
    // Duyệt qua event OrderPlaced để gom đơn của tôi (buyer/seller) :contentReference[oaicite:21]{index=21}
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const { MUABAN_ADDR } = readAddrs();
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, topics:[topic], fromBlock:0, toBlock:"latest" });

    ordersBuyer=[]; ordersSeller=[];
    for(const l of logs){
      const ev = iface.parseLog(l);
      const oid = Number(ev.args.orderId);
      const o = await muabanR.getOrder(oid); // view :contentReference[oaicite:22]{index=22}
      if (String(o.buyer).toLowerCase()===String(account).toLowerCase()) ordersBuyer.push(o);
      if (String(o.seller).toLowerCase()===String(account).toLowerCase()) ordersSeller.push(o);
    }
    renderOrders();
  }catch(e){ console.error("loadMyOrders:", e); }
}
function statusText(st){ return ({0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"})[Number(st)]||"-"; }
function renderOrders(){
  const lb=$("#ordersBuyList"), ls=$("#ordersSellList");
  if(lb){ lb.innerHTML=""; for(const o of ordersBuyer){ lb.appendChild(orderCard(o, true)); } }
  if(ls){ ls.innerHTML=""; for(const o of ordersSeller){ ls.appendChild(orderCard(o, false)); } }
}
function orderCard(o, isBuyer){
  const el=document.createElement("div"); el.className="order-card";
  el.innerHTML=`
    <div class="order-row"><span class="order-strong">#${o.orderId}</span> | PID ${o.productId} | ${statusText(o.status)}</div>
    <div class="order-row">Số lượng: ${o.quantity} | VIN ký quỹ: ${ethers.utils.formatUnits(o.vinAmount,18)}</div>
    <div class="order-row">Buyer: ${short(o.buyer)} | Seller: ${short(o.seller)}</div>
    <div class="order-row">Hạn giao: ${new Date(Number(o.deadline)*1000).toLocaleString('vi-VN')}</div>
    <div class="card-actions">
      ${ isBuyer
          ? (Number(o.status)===1
              ? `<button class="btn" data-a="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
                 <button class="btn" data-a="refund"  data-oid="${o.orderId}">Hoàn tiền (quá hạn)</button>`
              : ``)
          : ``
        }
    </div>`;
  el.querySelector('[data-a="confirm"]')?.addEventListener("click", ()=>confirmReceipt(Number(o.orderId)));
  el.querySelector('[data-a="refund"]') ?.addEventListener("click", ()=>refundOrder(Number(o.orderId)));
  return el;
}
async function confirmReceipt(oid){
  try{
    const txData = await muaban.populateTransaction.confirmReceipt(oid); // :contentReference[oaicite:23]{index=23}
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ return toast(parseRevert(simErr)); }
    const tx = await muaban.confirmReceipt(oid, legacyOverrides("light"));
    await tx.wait();
    toast("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "confirmReceipt"); }
}
async function refundOrder(oid){
  try{
    if(!window.confirm("Bạn chắc chắn muốn yêu cầu hoàn tiền?")) return;
    const txData = await muaban.populateTransaction.refundOrder(oid); // :contentReference[oaicite:24]{index=24}
    txData.from = account;
    try{ await providerWrite.call(txData); }
    catch(simErr){ return toast(parseRevert(simErr)); }
    const tx = await muaban.refundOrder(oid, legacyOverrides("light"));
    await tx.wait();
    toast("Yêu cầu hoàn tiền đã thực hiện.");
    await loadMyOrders();
  }catch(e){ showRpc(e, "refundOrder"); }
}

// ======================= Init =======================
async function boot(){
  await loadAbis();
  initProviders();
  initContractsForRead();
  fetchVinToVND();
  loadAllProducts();

  // menu/nav buttons đã khai báo ở trên
}
document.addEventListener("DOMContentLoaded", boot);
</script>
