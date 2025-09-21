/* ==========================================================================
   Muaban.vin — app.js (FULL, 2025-09-21)
   - Unlock MetaMask prompt khi ví đang khóa
   - Menu sau kết nối luôn hiện 3 nút; disable nếu chưa đăng ký
   - Giá VIN/VND đúng mô tả; hiển thị chip giá
   - Sản phẩm: quét + hiển thị + tìm kiếm + đăng + cập nhật
   - Mua: tính vinPerVND, approve tự động, placeOrder
   - Đơn mua/đơn bán: quét, hiển thị, confirm, refund
   ========================================================================== */

/* =========================== 0) CẤU HÌNH ============================ */
// Địa chỉ hợp đồng (theo tài liệu bạn gửi)
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0"; // Muaban (VIC)
const VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4"; // VIN (VIC)

// API giá
const BINANCE_VICUSDT    = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

// Chain Viction
const VIC_CHAIN_ID_HEX = "0x58"; // 88
// Explorer
const EXPLORER = "https://www.vicscan.xyz";

/* ======================= 1) BIẾN & TIỆN ÍCH ======================= */
let provider, signer, account;
let muaban, vin;
let MUABAN_ABI, VIN_ABI;

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

const BN = (x) => ethers.BigNumber.from(String(x));
const short = (a) => a ? a.slice(0,6) + "…" + a.slice(-4) : "";
const show  = (el) => el.classList.remove("hidden");
const hide  = (el) => el.classList.add("hidden");
const setHidden = (el, yes=true) => el.classList.toggle("hidden", !!yes);
const sleep = (ms) => new Promise(r=>setTimeout(r, ms));

function toast(msg){ alert(msg); }
function escapeHTML(s){
  return (s||"").replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function parseRpcError(err){
  try{
    return err?.error?.message || err?.data?.message || err?.message || "Giao dịch bị hủy hoặc revert.";
  }catch(_){ return "Giao dịch bị hủy hoặc revert."; }
}

/* ==================== 2) TẢI ABI từ file JSON ==================== */
async function loadABIs(){
  if (!MUABAN_ABI) MUABAN_ABI = await (await fetch("Muaban_ABI.json", {cache:"no-store"})).json();
  if (!VIN_ABI)     VIN_ABI    = await (await fetch("VinToken_ABI.json", {cache:"no-store"})).json();
}

/* ==================== 3) GIÁ VIN/VND theo mô tả ==================== */
/*
  VIN/VND = (VIC/USDT Binance × 100) × (USDT/VND CoinGecko)
  vinPerVNDWei = ceil(1e18 / VINVND)
*/
let priceCache = { ts:0, vinVnd:0 };
async function fetchVinVnd(){
  const now = Date.now();
  if (priceCache.vinVnd && now - priceCache.ts < 45000) return priceCache.vinVnd;
  try{
    const vic = await (await fetch(BINANCE_VICUSDT, {cache:"no-store"})).json();
    const vicUSDT = parseFloat(vic?.price || "0");
    const usd = await (await fetch(COINGECKO_USDT_VND, {cache:"no-store"})).json();
    const usdtVnd = Number(usd?.tether?.vnd || 0);
    const vinVnd = Math.floor(vicUSDT * 100 * usdtVnd);
    priceCache = { ts: now, vinVnd };
    return vinVnd;
  }catch(e){
    console.warn("fetchVinVnd error:", e);
    return 0;
  }
}
function vinPerVndWei(vinVndInt){
  const ONE = ethers.constants.WeiPerEther; // 1e18
  const v = BN(vinVndInt);
  if (v.isZero()) return BN(0);
  return ONE.add(v).sub(1).div(v); // ceil(1e18 / v)
}
async function updatePriceChip(){
  const el = byId("vinPrice");
  if (!el) return;
  el.textContent = "Loading price...";
  const vinVnd = await fetchVinVnd();
  el.textContent = vinVnd ? `1 VIN = ${vinVnd.toLocaleString("vi-VN")} VND` : "Không lấy được giá";
}

/* =========== 4) ÉP MetaMask bật UNLOCK khi đang khóa =========== */
async function requestAccountsWithPrompt(){
  const eth = window.ethereum;
  if (!eth) throw new Error("NO_METAMASK");
  try{
    const accs = await eth.request({ method: "eth_requestAccounts" });
    if (accs && accs.length) return accs;
  }catch(e){
    if (e && e.code === -32002){ // request pending
      toast("MetaMask đang yêu cầu ở cửa sổ trình duyệt. Vui lòng mở và xác nhận.");
      throw e;
    }
    throw e; // user rejected (4001)...
  }
  // Fallback
  try{
    await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
    const accs2 = await eth.request({ method: "eth_requestAccounts" });
    if (accs2 && accs2.length) return accs2;
  }catch(e){ throw e; }
  throw new Error("UNABLE_TO_GET_ACCOUNTS");
}
async function ensureVictionAfterUnlock(){
  const eth = window.ethereum;
  const chainId = await eth.request({ method: "eth_chainId" });
  if (chainId === VIC_CHAIN_ID_HEX) return;
  try{
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: VIC_CHAIN_ID_HEX }] });
  }catch(err){
    if (err && err.code === 4902){
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: VIC_CHAIN_ID_HEX,
          chainName: "Viction Mainnet",
          nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
          rpcUrls: ["https://rpc.viction.xyz"],
          blockExplorerUrls: ["https://scan.viction.xyz"]
        }]
      });
    }else{ throw err; }
  }
}

/* ====================== 5) KẾT NỐI VÍ ====================== */
async function connectWallet(){
  try{
    await loadABIs();
    await requestAccountsWithPrompt();  // ép mở hộp thoại unlock nếu đang khóa
    await ensureVictionAfterUnlock();

    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer   = provider.getSigner();
    account  = await signer.getAddress();

    muaban = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vin    = new ethers.Contract(VIN_ADDR,    VIN_ABI,    signer);

    // UI header
    hide(byId("btnConnect"));
    show(byId("walletBox"));
    const a = byId("accountShort");
    if (a){ a.textContent = short(account); a.href = `${EXPLORER}/address/${account}`; }

    await refreshBalances();
    await showMenuAfterConnect();
    await loadAllProducts();
  }catch(e){
    console.error("connectWallet error:", e);
    toast("Không kết nối được ví. Hãy kiểm tra MetaMask & thử lại.");
  }
}
byId("btnConnect")?.addEventListener("click", connectWallet);
byId("btnDisconnect")?.addEventListener("click", ()=>location.reload());

/* ====================== 6) MENU SAU KHI KẾT NỐI ====================== */
async function isRegistered(){
  try{ return await muaban.registered(account); }catch{ return false; }
}
function setMenuState(connected, registered){
  const menu = byId("menuBox");
  if (menu) setHidden(menu, !connected);

  // Nút Đăng ký
  const btnReg = byId("btnRegister");
  if (btnReg) setHidden(btnReg, !!registered);

  // 3 nút luôn hiện sau khi kết nối; disable nếu chưa đăng ký
  ["btnCreate","btnOrdersBuy","btnOrdersSell"].forEach(id=>{
    const el = byId(id); if (!el) return;
    setHidden(el, !connected);
    el.disabled = !registered;
    el.dataset.needsReg = (!registered).toString();
  });
}
async function showMenuAfterConnect(){
  const reg = await isRegistered();
  setMenuState(true, reg);
}

/* ====================== 7) ĐĂNG KÝ VÍ ====================== */
byId("btnRegister")?.addEventListener("click", onRegister);
async function onRegister(){
  try{
    const fee = await muaban.REG_FEE();
    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(fee)){
      const tx1 = await vin.approve(MUABAN_ADDR, fee);
      await tx1.wait();
    }
    const tx2 = await muaban.payRegistration();
    await tx2.wait();

    toast("Đăng ký thành công!");
    setMenuState(true, true);
  }catch(e){
    console.error("payRegistration error:", e);
    toast("Đăng ký thất bại. Kiểm tra số dư VIN và thử lại.");
  }finally{
    refreshBalances();
  }
}

/* ====================== 8) SỐ DƯ ====================== */
async function refreshBalances(){
  if (!vin || !provider || !account) return;
  try{
    const [vinBal, vicBal] = await Promise.all([
      vin.balanceOf(account),
      provider.getBalance(account)
    ]);
    byId("vinBalance") && (byId("vinBalance").textContent = `VIN: ${ethers.utils.formatUnits(vinBal,18).slice(0,6)}`);
    byId("vicBalance") && (byId("vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`);
  }catch(e){
    console.warn("refreshBalances error:", e);
  }
}

/* ====================== 9) SẢN PHẨM: QUÉT/RENDER/TÌM ====================== */
const productCache = new Map();

function unitFromDesc(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(desc.trim());
  return m ? m[1].trim() : "";
}
function productCardHTML(p){
  const pid  = Number(p.productId);
  const unit = unitFromDesc(p.descriptionCID);
  const price = Number(p.priceVND);
  const active = !!p.active;

  const thumb = p.imageCID?.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${p.imageCID.replace("ipfs://","")}`
    : p.imageCID;

  const me = account && p.seller && (account.toLowerCase() === p.seller.toLowerCase());
  const stockCls = active ? "stock-badge" : "stock-badge out";
  const stockTxt = active ? "Còn hàng" : "Hết hàng";

  const buyBtn = active && !me ? `<button class="btn primary" data-act="buy" data-pid="${pid}">Mua</button>` : "";
  const updBtn = me ? `<button class="btn" data-act="update" data-pid="${pid}">Cập nhật sản phẩm</button>` : "";

  return `
    <article class="product-card" data-pid="${pid}">
      <img class="product-thumb" src="${thumb || ""}" alt="">
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${escapeHTML(p.name||"Sản phẩm")}</h3>
          <span class="${stockCls}">${stockTxt}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${price.toLocaleString("vi-VN")} VND</span>
          ${unit ? `<span class="unit">/ ${escapeHTML(unit)}</span>` : ""}
        </div>
        <div class="product-meta">
          <span class="mono">Seller: <a href="${EXPLORER}/address/${p.seller}" target="_blank" rel="noopener">${short(p.seller)}</a></span>
          <span class="badge">PID: ${pid}</span>
        </div>
        <div class="card-actions">
          ${buyBtn}
          ${updBtn}
          ${thumb ? `<a class="btn" href="${thumb}" target="_blank" rel="noopener">Xem ảnh/video</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

async function loadAllProducts(){
  const list = byId("productList"); if (!list) return;
  list.innerHTML = `<p>Đang tải sản phẩm…</p>`;
  const MAX_SCAN = 600;
  const MAX_EMPTY = 30;
  let html = "", empty = 0;

  for (let pid=1; pid<=MAX_SCAN; pid++){
    try{
      const p = await muaban.getProduct(pid); // struct Product
      if (!p || !p.seller || p.seller === ethers.constants.AddressZero){
        empty++; if (empty>=MAX_EMPTY) break; else continue;
      }
      empty=0;
      productCache.set(pid, p);
      html += productCardHTML(p);
    }catch{
      empty++; if (empty>=MAX_EMPTY) break;
    }
  }
  list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
}

byId("btnSearch")?.addEventListener("click", onSearch);
byId("searchInput")?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") onSearch(); });
function onSearch(){
  const q = byId("searchInput")?.value.trim().toLowerCase() || "";
  const list = byId("productList"); if (!list) return;
  if (!q){
    let html = ""; for (const [,p] of productCache) html += productCardHTML(p);
    list.innerHTML = html || `<p>(Chưa có sản phẩm nào)</p>`;
    return;
  }
  let html = "";
  for (const [,p] of productCache){
    if ((p.name||"").toLowerCase().includes(q)) html += productCardHTML(p);
  }
  list.innerHTML = html || `<p>Không tìm thấy sản phẩm phù hợp.</p>`;
}

/* ====================== 10) CREATE PRODUCT ====================== */
byId("btnCreate")?.addEventListener("click", ()=>{
  const el = byId("btnCreate");
  if (el?.dataset.needsReg === "true"){ toast("Bạn cần Đăng ký (0.001 VIN) trước khi đăng sản phẩm."); return; }
  show(byId("formCreate"));
  document.body.classList.add("no-scroll");
});
$$("#formCreate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formCreate"));
    document.body.classList.remove("no-scroll");
  });
});
byId("btnSubmitCreate")?.addEventListener("click", submitCreate);

async function submitCreate(){
  try{
    if (!muaban) await connectWallet();

    // Kiểm tra đã đăng ký
    const isReg = await muaban.registered(account);
    if (!isReg){ toast("Bạn chưa đăng ký. Bấm 'Đăng ký' (0.001 VIN) trước khi đăng sản phẩm."); return; }

    // Lấy input
    const name   = byId("createName")?.value.trim();
    const ipfs   = byId("createIPFS")?.value.trim();
    const unit   = byId("createUnit")?.value.trim();
    const priceN = Math.floor(Number(byId("createPrice")?.value||0));
    const wallet = byId("createWallet")?.value.trim();
    const daysN  = Math.floor(Number(byId("createDays")?.value||0));

    // Validate
    if (!name || !ipfs || !unit || !priceN || !wallet || !daysN){ toast("Vui lòng nhập đủ thông tin và số > 0."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận tiền (payoutWallet) không hợp lệ."); return; }
    if (wallet === ethers.constants.AddressZero){ toast("Ví nhận tiền không được là 0x000..."); return; }
    if (daysN < 1 || daysN > 4294967295){ toast("Số ngày giao tối đa không hợp lệ (1..4294967295)."); return; }

    const descriptionCID   = `unit:${unit}`;
    const imageCID         = ipfs;
    const priceVND         = BN(priceN);       // uint256
    const deliveryDaysMax  = daysN >>> 0;      // uint32
    const payoutWallet     = wallet;
    const active           = true;

    // estimateGas để bắt lý do revert sớm
    let gasLimit;
    try{
      const est = await muaban.estimateGas.createProduct(
        name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active
      );
      gasLimit = est.mul(120).div(100);
    }catch(estErr){
      const reason = parseRpcError(estErr);
      console.error("estimateGas.createProduct revert:", estErr);
      toast("Không thể đăng sản phẩm (ước tính gas bị revert):\n" + reason);
      return;
    }

    // Gửi giao dịch
    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, priceVND, deliveryDaysMax, payoutWallet, active,
      { gasLimit }
    );
    await tx.wait();

    toast("Đăng sản phẩm thành công.");
    hide(byId("formCreate"));
    document.body.classList.remove("no-scroll");
    await loadAllProducts();

  }catch(e){
    console.error("createProduct error:", e);
    const reason = parseRpcError(e);
    toast("Đăng sản phẩm thất bại:\n" + reason);
  }
}

/* ====================== 11) UPDATE PRODUCT ====================== */
document.addEventListener("click", (e)=>{
  const btn = e.target.closest("[data-act='update']");
  if (!btn) return;
  const pid = Number(btn.getAttribute("data-pid"));
  openUpdateModal(pid);
});
$$("#formUpdate .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formUpdate"));
    document.body.classList.remove("no-scroll");
  });
});
byId("btnSubmitUpdate")?.addEventListener("click", submitUpdate);

function fillUpdateModal(p){
  byId("updatePid").value      = String(p.productId);
  byId("updatePrice").value    = String(p.priceVND);
  byId("updateDays").value     = String(p.deliveryDaysMax);
  byId("updateWallet").value   = p.payoutWallet;
  byId("updateActive").checked = !!p.active;
}
async function openUpdateModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){ toast("Sản phẩm không tồn tại."); return; }
    if (!account || p.seller.toLowerCase() !== account.toLowerCase()){ toast("Chỉ seller mới được cập nhật."); return; }
    fillUpdateModal(p);
    show(byId("formUpdate"));
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openUpdateModal error:", e);
  }
}
async function submitUpdate(){
  try{
    const pid    = Number(byId("updatePid")?.value);
    const price  = Math.max(1, Number(byId("updatePrice")?.value||0));
    const days   = Math.max(1, Number(byId("updateDays")?.value||0));
    const wallet = byId("updateWallet")?.value.trim();
    const active = !!byId("updateActive")?.checked;
    if (!pid || !price || !days || !wallet){ toast("Điền đủ thông tin."); return; }
    if (!ethers.utils.isAddress(wallet)){ toast("Ví nhận tiền không hợp lệ."); return; }

    const tx = await muaban.updateProduct(pid, BN(price), days, wallet, active);
    await tx.wait();

    toast("Cập nhật thành công.");
    hide(byId("formUpdate"));
    document.body.classList.remove("no-scroll");
    const pNew = await muaban.getProduct(pid);
    productCache.set(pid, pNew);
    onSearch();
  }catch(e){
    console.error("submitUpdate error:", e);
    toast("Cập nhật thất bại.");
  }
}

/* ====================== 12) BUY (MUA HÀNG) ====================== */
document.addEventListener("click", async (e)=>{
  const btn = e.target.closest("[data-act='buy']");
  if (!btn) return;
  if (byId("btnCreate")?.dataset.needsReg === "true"){ toast("Bạn cần Đăng ký (0.001 VIN) trước khi mua."); return; }
  const pid = Number(btn.getAttribute("data-pid"));
  await openBuyModal(pid);
});
$$("#formBuy .close").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    hide(byId("formBuy"));
    document.body.classList.remove("no-scroll");
  });
});
byId("buyQty")?.addEventListener("input", updateBuyTotalVIN);
byId("btnSubmitBuy")?.addEventListener("click", submitBuy);

let currentBuyPID = null;
function demoEncrypt(obj){ // base64 demo để tránh plaintext; có thể nâng cấp PKE
  const s = JSON.stringify(obj||{});
  return btoa(unescape(encodeURIComponent(s)));
}
async function openBuyModal(pid){
  try{
    const p = productCache.get(pid) || await muaban.getProduct(pid);
    if (!p || !p.seller || p.seller === ethers.constants.AddressZero){ toast("Sản phẩm không tồn tại."); return; }
    if (!p.active){ toast("Sản phẩm tạm hết hàng."); return; }
    currentBuyPID = pid;

    const unit = unitFromDesc(p.descriptionCID);
    byId("buyProductInfo").innerHTML = `
      <div><strong>${escapeHTML(p.name)}</strong></div>
      <div>${Number(p.priceVND).toLocaleString("vi-VN")} VND ${unit?("/ "+escapeHTML(unit)):""}</div>
      <div>Giao hàng tối đa: ${p.deliveryDaysMax} ngày</div>
    `;
    byId("buyName").value = "";
    byId("buyAddress").value = "";
    byId("buyPhone").value = "";
    byId("buyNote").value = "";
    byId("buyQty").value = "1";

    await updateBuyTotalVIN();
    show(byId("formBuy"));
    document.body.classList.add("no-scroll");
  }catch(e){
    console.error("openBuyModal error:", e);
  }
}
async function updateBuyTotalVIN(){
  try{
    if (!currentBuyPID) return;
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const qty = Math.max(1, Number(byId("buyQty")?.value||1));
    const vinVnd = await fetchVinVnd();
    const per = vinPerVndWei(vinVnd);
    const totalVND = BN(p.priceVND).mul(qty);
    const estWei = totalVND.mul(per); // hợp đồng còn ceilDiv để bảo vệ seller
    const estVin = Number(ethers.utils.formatUnits(estWei, 18));
    byId("buyTotalVIN").textContent = `Tổng VIN cần trả (ước tính): ${estVin.toFixed(6)} VIN`;
  }catch(e){
    console.warn("updateBuyTotalVIN error:", e);
  }
}
async function submitBuy(){
  try{
    if (!muaban || !vin) await connectWallet();

    const name  = byId("buyName")?.value.trim();
    const addr  = byId("buyAddress")?.value.trim();
    const phone = byId("buyPhone")?.value.trim();
    const note  = byId("buyNote")?.value.trim();
    const qty   = Math.max(1, Number(byId("buyQty")?.value||1));
    if (!name || !addr){ toast("Vui lòng nhập Họ tên & Địa chỉ."); return; }

    const infoCipher = demoEncrypt({name,addr,phone,note});
    const vinVnd = await fetchVinVnd();
    if (!vinVnd){ toast("Không lấy được giá quy đổi."); return; }
    const per = vinPerVndWei(vinVnd);

    // Ước tính & approve dư 1%
    const p = productCache.get(currentBuyPID) || await muaban.getProduct(currentBuyPID);
    const est = BN(p.priceVND).mul(qty).mul(per);
    const need = est.mul(101).div(100);

    const allowance = await vin.allowance(account, MUABAN_ADDR);
    if (allowance.lt(need)){
      const tx1 = await vin.approve(MUABAN_ADDR, need);
      await tx1.wait();
    }

    // placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.placeOrder(currentBuyPID, qty, per, infoCipher);
    await tx.wait();

    toast("Đặt mua thành công. VIN đã ký gửi trong hợp đồng.");
    hide(byId("formBuy"));
    document.body.classList.remove("no-scroll");
    await refreshBalances();
  }catch(e){
    console.error("submitBuy error:", e);
    toast("Mua thất bại. Kiểm tra số dư VIN & thử lại.");
  }
}

/* ====================== 13) ĐƠN HÀNG: BUY/SELL ====================== */
byId("btnOrdersBuy")?.addEventListener("click", async ()=>{
  if (byId("btnOrdersBuy")?.dataset.needsReg === "true"){ toast("Hãy Đăng ký trước."); return; }
  await renderOrdersBuy();
});
byId("btnOrdersSell")?.addEventListener("click", async ()=>{
  if (byId("btnOrdersSell")?.dataset.needsReg === "true"){ toast("Hãy Đăng ký trước."); return; }
  await renderOrdersSell();
});

async function scanMyOrders(){
  const MAX_SCAN = 1000, MAX_EMPTY = 40;
  const mineBuy=[], mineSell=[];
  let empty=0;
  for (let oid=1; oid<=MAX_SCAN; oid++){
    try{
      const o = await muaban.getOrder(oid); // struct Order
      if (!o || !o.orderId || BN(o.orderId).isZero()){ empty++; if(empty>=MAX_EMPTY) break; else continue; }
      empty=0;
      if (account){
        if (o.buyer && o.buyer.toLowerCase()===account.toLowerCase()) mineBuy.push(o);
        if (o.seller&& o.seller.toLowerCase()===account.toLowerCase()) mineSell.push(o);
      }
    }catch{ empty++; if (empty>=MAX_EMPTY) break; }
  }
  return { mineBuy, mineSell };
}
function orderRowHTML(o){
  const stL = ["NONE","PLACED","RELEASED","REFUNDED"];
  const st  = stL[Number(o.status)||0] || String(o.status);
  const vin = Number(ethers.utils.formatUnits(o.vinAmount,18)).toFixed(6);
  return `
    <div class="order-card" data-oid="${o.orderId}">
      <div class="order-row"><span class="order-strong">OID:</span> #${o.orderId}</div>
      <div class="order-row"><span class="order-strong">PID:</span> ${o.productId}</div>
      <div class="order-row">
        <span class="order-strong">Buyer:</span> <a class="mono" href="${EXPLORER}/address/${o.buyer}" target="_blank" rel="noopener">${short(o.buyer)}</a>
        <span class="order-strong">Seller:</span> <a class="mono" href="${EXPLORER}/address/${o.seller}" target="_blank" rel="noopener">${short(o.seller)}</a>
      </div>
      <div class="order-row"><span class="order-strong">Qty:</span> ${o.quantity}</div>
      <div class="order-row"><span class="order-strong">VIN ký gửi:</span> ${vin} VIN</div>
      <div class="order-row"><span class="order-strong">Trạng thái:</span> ${st}</div>
      <div class="card-actions">
        ${st==="PLACED" && account && o.buyer.toLowerCase()===account.toLowerCase()
          ? `<button class="btn primary" data-act="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
             <button class="btn" data-act="refund"  data-oid="${o.orderId}">Hoàn tiền khi quá hạn</button>`
          : ""}
      </div>
    </div>
  `;
}
async function renderOrdersBuy(){
  const sec = byId("ordersBuySection"), other = byId("ordersSellSection");
  if (other) hide(other); if (sec) show(sec);
  const { mineBuy } = await scanMyOrders();
  const list = byId("ordersBuyList");
  list && (list.innerHTML = mineBuy.length ? mineBuy.map(orderRowHTML).join("") : `<p>(Chưa có đơn mua)</p>`);
  sec?.scrollIntoView({behavior:"smooth", block:"start"});
}
async function renderOrdersSell(){
  const sec = byId("ordersSellSection"), other = byId("ordersBuySection");
  if (other) hide(other); if (sec) show(sec);
  const { mineSell } = await scanMyOrders();
  const list = byId("ordersSellList");
  list && (list.innerHTML = mineSell.length ? mineSell.map(orderRowHTML).join("") : `<p>(Chưa có đơn bán)</p>`);
  sec?.scrollIntoView({behavior:"smooth", block:"start"});
}

/* ====================== 14) ACTIONS: CONFIRM / REFUND ====================== */
document.addEventListener("click", async (e)=>{
  const cBtn = e.target.closest("[data-act='confirm']");
  const rBtn = e.target.closest("[data-act='refund']");
  if (cBtn){
    try{
      const oid = Number(cBtn.getAttribute("data-oid"));
      const tx = await muaban.confirmReceipt(oid); // giải ngân VIN cho seller
      await tx.wait();
      toast("Đã xác nhận nhận hàng.");
      await renderOrdersBuy();
      await refreshBalances();
    }catch(err){
      console.error("confirmReceipt error:", err);
      toast("Xác nhận thất bại.");
    }
  }else if (rBtn){
    try{
      const oid = Number(rBtn.getAttribute("data-oid"));
      const tx = await muaban.refundIfExpired(oid); // hoàn VIN nếu quá hạn
      await tx.wait();
      toast("Yêu cầu hoàn tiền đã thực hiện (nếu đơn quá hạn).");
      await renderOrdersBuy();
      await refreshBalances();
    }catch(err){
      console.error("refundIfExpired error:", err);
      toast("Hoàn tiền thất bại (có thể chưa quá hạn).");
    }
  }
});

/* ====================== 15) SỰ KIỆN METAMASK ====================== */
if (window.ethereum){
  window.ethereum.on?.("accountsChanged", ()=>location.reload());
  window.ethereum.on?.("chainChanged",   ()=>location.reload());
}

/* ====================== 16) KHỞI ĐỘNG UI ====================== */
window.addEventListener("load", async ()=>{
  await updatePriceChip();
  setInterval(updatePriceChip, 60000);
});
