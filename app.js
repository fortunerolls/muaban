/* ====================================================================
   muaban.vin — app.js (ethers v5, tối giản mà đầy đủ)
   - Sửa nút "Kết nối ví" không hoạt động
   - Hiển thị "1 VIN = ... VND" ổn định (theo mô tả tỉ giá VIN/VND)
   - Ép legacy tx (type:0 + gasPrice) tránh lỗi EIP-1559 trên VIC
   - Preflight simulate để bắt reason khi hợp đồng revert
==================================================================== */

/* =============== Helpers DOM =============== */
const $  = (q)=>document.querySelector(q);
const $$ = (q)=>document.querySelectorAll(q);
const show = el=>{ if(el) el.classList.remove('hidden'); };
const hide = el=>{ if(el) el.classList.add('hidden'); };
const short=(a)=>a?`${a.slice(0,6)}…${a.slice(-4)}`:"";
const toast=(m)=>alert(m);

/* =============== Hằng số & cấu hình =============== */
const DEFAULTS = {
  CHAIN_ID: 88,
  RPC_URL: "https://rpc.viction.xyz",
  EXPLORER: "https://vicscan.xyz",
  MUABAN_ADDR: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN_ADDR:    "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE_WEI: "1000000000000000", // 0.001 VIN
  // Nguồn tỷ giá (theo mô tả trong tài liệu của bạn)
  COINGECKO_VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  COINGECKO_USD_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  COINGECKO_VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  BINANCE_VICUSDT:   "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT",
};

// Gas/fees: ép legacy (type 0) để hợp RPC VIC
const GAS_LIMIT_LIGHT = ethers.BigNumber.from("200000");
const GAS_LIMIT_MED   = ethers.BigNumber.from("400000");
const GAS_LIMIT_HEAVY = ethers.BigNumber.from("800000");
const LEGACY_GAS_PRICE_GWEI = "50";

/* =============== Biến trạng thái =============== */
let providerRead, providerWrite, signer, account;
let MUABAN_ABI, VIN_ABI;
let muabanR, vinR; // read
let muaban,  vin;  // write
let isRegistered = false;

let vinPerVNDWei = ethers.BigNumber.from(0); // VIN wei / 1 VND (làm tròn lên)
let vinVND = 0;                               // 1 VIN = ? VND (số nguyên)

/* =============== Utils =============== */
function showRpc(err, tag="RPC"){
  const obj = {
    tag, code: err?.code,
    message: err?.message || err?.error?.message,
    data: err?.data || err?.error?.data,
    reason: err?.reason,
  };
  console.error(tag, obj);
  alert(`${tag}\n${JSON.stringify(obj, null, 2)}`);
}
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký.",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không được để trống.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm này.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Thiếu tỷ giá VIN/VND.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thực hiện được.",
    NOT_EXPIRED: "Đơn chưa quá hạn."
  };
  for (const k in map) if (raw.includes(k)) return map[k];
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  return m ? m[1] : (raw || "Giao dịch bị từ chối hoặc dữ liệu không hợp lệ.");
}
function parseVND(s){
  const d = String(s||"").replace(/[^\d]/g,"");
  if(!d) return NaN;
  const n = Number(d);
  return Number.isFinite(n)? n : NaN;
}
function ipfsToHttp(link){
  if (!link) return "";
  return link.startsWith("ipfs://") ? ("https://ipfs.io/ipfs/" + link.slice(7)) : link;
}
function parseUnitFromCID(desc){
  if (!desc) return "";
  const m = /^unit:(.+)$/i.exec(String(desc).trim());
  return m? m[1].trim() : "";
}

/* =============== ABI & địa chỉ =============== */
async function loadAbis(){
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());   // đúng theo file bạn gửi
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json()); // đúng theo file bạn gửi
  // Muaban_ABI có các hàm: payRegistration, createProduct, updateProduct, placeOrder, confirmReceipt, refundIfExpired, getProduct, getOrder… :contentReference[oaicite:3]{index=3}
  // VinToken_ABI có approve, allowance, balanceOf… :contentReference[oaicite:4]{index=4}
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

/* =============== Provider & contract =============== */
function initProviders(){
  providerRead  = new ethers.providers.JsonRpcProvider(DEFAULTS.RPC_URL);
  providerWrite = window.ethereum ? new ethers.providers.Web3Provider(window.ethereum, "any") : null;
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

/* =============== Tỷ giá VIN/VND (theo mô tả) =============== */
// Tài liệu: VIN/VND = (VIC/USDT × 100) × (USDT/VND) (lấy nguồn Binance + CoinGecko) :contentReference[oaicite:5]{index=5}
async function fetchVinToVND(){
  try{
    // 1) Coingecko VIC→VND
    let vicVnd = 0;
    try{
      const r = await fetch(DEFAULTS.COINGECKO_VIC_VND);
      vicVnd = Number((await r.json())?.viction?.vnd || 0);
    }catch(_){}
    if (vicVnd>0){
      vinVND = Math.floor(vicVnd * 100);
    }else{
      // 2) VIC→USD × USDT→VND
      const [vicUsdRes, usdtVndRes] = await Promise.all([
        fetch(DEFAULTS.COINGECKO_VIC_USD),
        fetch(DEFAULTS.COINGECKO_USD_VND)
      ]);
      const vicUsd = Number((await vicUsdRes.json())?.viction?.usd || 0);
      const usdtVnd= Number((await usdtVndRes.json())?.tether?.vnd || 0);
      if (vicUsd>0 && usdtVnd>0){
        vinVND = Math.floor(vicUsd * 100 * usdtVnd);
      }else{
        // 3) Binance VIC/USDT × USDT→VND
        const [vicUsdtRes, usdtVndRes2] = await Promise.all([
          fetch(DEFAULTS.BINANCE_VICUSDT),
          fetch(DEFAULTS.COINGECKO_USD_VND)
        ]);
        const vicUsdt = Number((await vicUsdtRes.json())?.price||0);
        const usdtVnd2= Number((await usdtVndRes2.json())?.tether?.vnd||0);
        if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt*100*usdtVnd2);
      }
    }
    if (!(vinVND>0)) throw new Error("Không lấy được giá");

    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil

    const chip = $("#vinPrice");
    if (chip) chip.textContent = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;
  }catch(e){
    console.error("fetchVinToVND", e);
    const chip = $("#vinPrice");
    if (chip) chip.textContent = "Đang tải giá…";
  }
}

/* =============== Gas override (legacy) =============== */
function gasOverrides(kind="med"){
  const ov = { type: 0, gasPrice: ethers.utils.parseUnits(LEGACY_GAS_PRICE_GWEI, "gwei") };
  ov.gasLimit = (kind==="light") ? GAS_LIMIT_LIGHT : (kind==="heavy") ? GAS_LIMIT_HEAVY : GAS_LIMIT_MED;
  return ov;
}

/* =============== Kết nối / Ngắt kết nối ví =============== */
async function connectWallet(){
  try{
    if (!window.ethereum){ toast("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==DEFAULTS.CHAIN_ID){ toast("Sai mạng. Hãy chọn Viction (chainId=88)."); return; }

    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();
    initContractsForWrite();

    hide($("#btnConnect"));
    show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${DEFAULTS.EXPLORER}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    isRegistered = !!reg;
    refreshMenu();

    await Promise.all([loadAllProducts(), loadMyOrders()]);
  }catch(e){ showRpc(e, "connectWallet"); }
}
function disconnectWallet(){
  account=null; signer=null; muaban=null; vin=null;
  hide($("#walletBox")); show($("#btnConnect"));
  $("#vinBalance").textContent="VIN: 0";
  $("#vicBalance").textContent="VIC: 0";
  isRegistered=false;
  refreshMenu();
}
function refreshMenu(){
  const btnReg=$("#btnRegister"), btnCrt=$("#btnCreate"), btnOB=$("#btnOrdersBuy"), btnOS=$("#btnOrdersSell");
  const menu=$("#menuBox");
  if (!account){
    show(btnReg); if(btnReg) btnReg.disabled = true;
    hide(btnCrt); hide(btnOB); hide(btnOS);
    return;
  }
  if (!isRegistered){
    show(btnReg); if(btnReg) btnReg.disabled = false;
    hide(btnCrt); hide(btnOB); hide(btnOS);
  }else{
    hide(btnReg);
    show(btnCrt); show(btnOB); show(btnOS);
  }
  if (menu) menu.classList.remove('hidden');
}

/* =============== Sản phẩm: tải & hiển thị =============== */
async function loadAllProducts(){
  try{
    const { MUABAN_ADDR } = readAddrs();
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const ids = [...new Set(logs.map(l=> Number(iface.parseLog(l).args.productId)))].sort((a,b)=>a-b);

    const list = [];
    for (const pid of ids){
      const p = await muabanR.getProduct(pid);
      list.push({pid, data: p});
    }
    renderProducts(list);
  }catch(e){ console.error("loadAllProducts", e); }
}
function renderProducts(items){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML="";
  if (!items?.length){ wrap.innerHTML = `<div class="tag">Chưa có sản phẩm.</div>`; return; }
  for (const {pid, data} of items){
    const unit = parseUnitFromCID(data.descriptionCID);
    const img  = ipfsToHttp(data.imageCID);
    const card = document.createElement("div");
    card.className="product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${String(data.name||"").slice(0,500)}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${Number(data.priceVND).toLocaleString('vi-VN')} VND</span>
          <span class="unit">/ ${unit||"đơn vị"}</span>
        </div>
        <div>
          <span class="stock-badge ${data.active? "":"out"}">${data.active? "Còn hàng":"Hết hàng"}</span>
          <span class="tag mono">Người bán: ${short(String(data.seller))}</span>
          <span class="tag">Giao tối đa ${Number(data.deliveryDaysMax)} ngày</span>
        </div>
        <div class="card-actions">
          ${!account ? "" :
            (String(data.seller).toLowerCase()===account
              ? `<button class="btn" data-u="${pid}">Cập nhật sản phẩm</button>`
              : (isRegistered && data.active ? `<button class="btn primary" data-b="${pid}">Mua</button>` : ""))
          }
        </div>
      </div>`;
    card.querySelector(`[data-b="${pid}"]`)?.addEventListener("click",()=> openBuyForm(pid, data));
    card.querySelector(`[data-u="${pid}"]`)?.addEventListener("click",()=> openUpdateForm(pid, data));
    wrap.appendChild(card);
  }
}
$("#btnSearch")?.addEventListener("click", ()=>{
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { loadAllProducts(); return; }
  // Lọc client: chỉ đổi UI (cho gọn)
  const cards = $$(".product-card");
  cards.forEach(c=>{
    const title = c.querySelector(".product-title")?.textContent?.toLowerCase()||"";
    c.style.display = title.includes(q) ? "" : "none";
  });
});

/* =============== Đăng ký ví =============== */
$("#btnRegister")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví trước."); return; }
  try{
    const need = ethers.BigNumber.from(DEFAULTS.REG_FEE_WEI);
    const { MUABAN_ADDR } = readAddrs();
    // đảm bảo allowance đủ cho payRegistration (chuyển 0.001 VIN tới owner) :contentReference[oaicite:6]{index=6}
    const allow = await vinR.allowance(account, MUABAN_ADDR);
    if (allow.lt(need)){
      const txA = await vin.approve(MUABAN_ADDR, need, gasOverrides("light"));
      await txA.wait();
    }
    // simulate
    const txData = await muaban.populateTransaction.payRegistration();
    txData.from = account;
    await providerWrite.call(txData);
    // send
    const tx = await muaban.payRegistration(gasOverrides("med"));
    await tx.wait();

    isRegistered = true;
    toast("Đăng ký thành công.");
    refreshMenu();
  }catch(e){ toast(parseRevert(e)); }
});

/* =============== Đăng/Cập nhật sản phẩm =============== */
$("#btnCreate")?.addEventListener("click", ()=>{
  if (!isRegistered){ toast("Bạn chưa đăng ký ví."); return; }
  $("#createName").value=""; $("#createIPFS").value="";
  $("#createUnit").value=""; $("#createPrice").value="";
  $("#createWallet").value=account||""; $("#createDays").value="3";
  show($("#formCreate"));
});
$(".modal#formCreate .close")?.addEventListener("click",()=> hide($("#formCreate")));

$("#btnSubmitCreate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (!isRegistered){ toast("Bạn chưa đăng ký ví."); return; }
  try{
    const name=($("#createName").value||"").slice(0,500).trim();
    const ipfs=($("#createIPFS").value||"").trim();
    const unit=($("#createUnit").value||"").trim();
    const price=parseVND($("#createPrice").value);
    const wallet=($("#createWallet").value||"").trim();
    const days = Number($("#createDays").value||0);
    if (!name||!ipfs||!unit||!price||!wallet||!days){ toast("Vui lòng nhập đủ thông tin."); return; }
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;

    // simulate & send (đúng thứ tự tham số createProduct) :contentReference[oaicite:7]{index=7}
    const txData = await muaban.populateTransaction.createProduct(
      name, descriptionCID, imageCID, ethers.BigNumber.from(String(price)), days, wallet, true
    );
    txData.from = account;
    await providerWrite.call(txData);

    const tx = await muaban.createProduct(
      name, descriptionCID, imageCID, ethers.BigNumber.from(String(price)), days, wallet, true, gasOverrides("heavy")
    );
    await tx.wait();

    hide($("#formCreate"));
    toast("Đăng sản phẩm thành công.");
    await loadAllProducts();
  }catch(e){ toast(parseRevert(e)); }
});

function openUpdateForm(pid, p){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = String(p.priceVND||"");
  $("#updateDays").value  = String(p.deliveryDaysMax||"");
  $("#updateWallet").value= String(p.payoutWallet||"");
  $("#updateActive").checked = !!p.active;
  show($("#formUpdate"));
}
$(".modal#formUpdate .close")?.addEventListener("click",()=> hide($("#formUpdate")));
$("#btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  try{
    const pid   = Number($("#updatePid").value||0);
    const price = parseVND($("#updatePrice").value);
    const days  = Number($("#updateDays").value||0);
    const wallet= ($("#updateWallet").value||"").trim();
    const active= !!$("#updateActive").checked;
    if (!pid||!price||!days||!wallet){ toast("Vui lòng nhập đủ thông tin."); return; }

    const txData = await muaban.populateTransaction.updateProduct(
      pid, ethers.BigNumber.from(String(price)), days, wallet, active
    );
    txData.from = account;
    await providerWrite.call(txData);

    const tx = await muaban.updateProduct(
      pid, ethers.BigNumber.from(String(price)), days, wallet, active, gasOverrides("med")
    );
    await tx.wait();

    hide($("#formUpdate"));
    toast("Cập nhật thành công.");
    await loadAllProducts();
  }catch(e){ toast(parseRevert(e)); }
});

/* =============== Mua hàng =============== */
function openBuyForm(pid, p){
  const m = $("#formBuy"); if (!m){ toast("Thiếu form mua hàng."); return; }
  m.dataset.pid = String(pid);
  $("#buyName").value=""; $("#buyAddress").value=""; $("#buyPhone").value=""; $("#buyNote").value="";
  $("#buyQty").value="1";
  updateTotalVinInBuyForm(p.priceVND||0, 1);
  show(m);
}
$(".modal#formBuy .close")?.addEventListener("click",()=> hide($("#formBuy")));
$("#buyQty")?.addEventListener("input", ()=>{
  const pid = Number($("#formBuy")?.dataset?.pid||0);
  if (!pid) return;
  muabanR.getProduct(pid).then(p=>{
    updateTotalVinInBuyForm(p.priceVND||0, Number($("#buyQty").value||1));
  }).catch(()=>{});
});
function updateTotalVinInBuyForm(priceVND, qty){
  const totalVND = (Number(priceVND)||0) * (Number(qty)||0);
  const el = $("#buyTotalVIN");
  if (!el) return;
  if (vinPerVNDWei.isZero()){ el.textContent = "Tổng VIN cần trả: …"; return; }
  const totalVinWei = ethers.BigNumber.from(String(totalVND)).mul(vinPerVNDWei);
  el.textContent = `Tổng VIN cần trả: ~ ${parseFloat(ethers.utils.formatUnits(totalVinWei,18)).toFixed(6)} VIN`;
}
$("#btnSubmitBuy")?.addEventListener("click", async ()=>{
  if (!account){ toast("Hãy kết nối ví."); return; }
  if (vinPerVNDWei.isZero()){ toast("Chưa tải được tỷ giá VIN/VND."); return; }
  try{
    const pid = Number($("#formBuy")?.dataset?.pid||0);
    const p = await muabanR.getProduct(pid);
    const qty   = Math.max(1, Number($("#buyQty").value||1));
    const name  = ($("#buyName").value||"").trim();
    const addr  = ($("#buyAddress").value||"").trim();
    const phone = ($("#buyPhone").value||"").trim();
    const note  = ($("#buyNote").value||"").trim();
    if (!name || !addr || !phone){ toast("Vui lòng nhập Họ tên/Địa chỉ/SĐT."); return; }

    const buyerInfoCipher = btoa(JSON.stringify({name,addr,phone,note}));
    const totalVND = ethers.BigNumber.from(String(Number(p.priceVND))).mul(qty);
    const totalVinWei = totalVND.mul(vinPerVNDWei);

    // Đảm bảo allowance đủ cho placeOrder(productId, quantity, vinPerVND, buyerInfoCipher) :contentReference[oaicite:8]{index=8}
    const { MUABAN_ADDR } = readAddrs();
    const allow = await vinR.allowance(account, MUABAN_ADDR);
    if (allow.lt(totalVinWei)){
      const txA = await vin.approve(MUABAN_ADDR, totalVinWei, gasOverrides("light"));
      await txA.wait();
    }

    const txData = await muaban.populateTransaction.placeOrder(
      pid, qty, vinPerVNDWei.toString(), buyerInfoCipher
    );
    txData.from = account;
    await providerWrite.call(txData);

    const tx = await muaban.placeOrder(pid, qty, vinPerVNDWei.toString(), buyerInfoCipher, gasOverrides("med"));
    await tx.wait();

    hide($("#formBuy"));
    toast("Đặt hàng thành công.");
    await loadMyOrders();
  }catch(e){ toast(parseRevert(e)); }
});

/* =============== Đơn hàng của tôi =============== */
async function loadMyOrders(){
  try{
    if (!account) return;
    const { MUABAN_ADDR } = readAddrs();
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("OrderPlaced");
    const logs = await providerRead.getLogs({ address: MUABAN_ADDR, fromBlock: 0, toBlock: "latest", topics: [topic] });

    const buyerIds = [], sellerPairs=[];
    for (const l of logs){
      const ev = iface.parseLog(l);
      const oid = Number(ev.args.orderId);
      const pid = Number(ev.args.productId);
      const buyer = String(ev.args.buyer).toLowerCase();
      if (buyer===account) buyerIds.push(oid);
      sellerPairs.push({oid,pid});
    }

    const ordersBuy  = [];
    const ordersSell = [];
    for (const oid of buyerIds){
      ordersBuy.push(await muabanR.getOrder(oid));
    }
    for (const {oid,pid} of sellerPairs){
      const p = await muabanR.getProduct(pid);
      if (String(p.seller).toLowerCase()===account){
        ordersSell.push(await muabanR.getOrder(oid));
      }
    }

    renderOrders("#ordersBuyList", ordersBuy, true);
    renderOrders("#ordersSellList", ordersSell, false);
  }catch(e){ console.error("loadMyOrders", e); }
}
function renderOrders(sel, list, isBuyer){
  const wrap = $(sel); if (!wrap) return;
  wrap.innerHTML = "";
  if (!list?.length){ wrap.innerHTML = `<div class="tag">${isBuyer?"Chưa có đơn mua.":"Chưa có đơn bán."}</div>`; return; }
  for (const o of list){
    const div = document.createElement("div");
    div.className = "order-card";
    const statusMap = {0:"-",1:"Đang xử lý",2:"Đã giải ngân",3:"Đã hoàn tiền"};
    div.innerHTML = `
      <div class="order-row"><span class="order-strong">#${o.orderId}</span> <span>${statusMap[Number(o.status)]||"-"}</span></div>
      <div class="order-row">Sản phẩm: #${o.productId} — SL: ${o.quantity}</div>
      <div class="order-row">VIN escrow: ${ethers.utils.formatUnits(o.vinAmount,18)}</div>
      <div class="card-actions">${isBuyer && Number(o.status)===1
        ? `<button class="btn" data-rcv="${o.orderId}">Xác nhận đã nhận hàng</button>
           <button class="btn" data-rf="${o.orderId}">Hoàn tiền</button>` : ""}</div>`;
    div.querySelector(`[data-rcv="${o.orderId}"]`)?.addEventListener("click", ()=> confirmReceipt(o.orderId));
    div.querySelector(`[data-rf="${o.orderId}"]`) ?.addEventListener("click", ()=> refundOrder(o.orderId));
    wrap.appendChild(div);
  }
}
async function confirmReceipt(oid){
  try{
    const txData = await muaban.populateTransaction.confirmReceipt(oid);
    txData.from = account;
    await providerWrite.call(txData);
    const tx = await muaban.confirmReceipt(oid, gasOverrides("light"));
    await tx.wait();
    toast("Đã xác nhận nhận hàng.");
    await loadMyOrders();
  }catch(e){ toast(parseRevert(e)); }
}
async function refundOrder(oid){
  try{
    const txData = await muaban.populateTransaction.refundIfExpired(oid);
    txData.from = account;
    await providerWrite.call(txData);
    const tx = await muaban.refundIfExpired(oid, gasOverrides("light"));
    await tx.wait();
    toast("Đã yêu cầu hoàn tiền.");
    await loadMyOrders();
  }catch(e){ toast(parseRevert(e)); }
}

/* =============== Điều hướng UI =============== */
$("#btnOrdersBuy")?.addEventListener("click", ()=>{ show($("#ordersBuySection")); hide($("#ordersSellSection")); });
$("#btnOrdersSell")?.addEventListener("click", ()=>{ show($("#ordersSellSection")); hide($("#ordersBuySection")); });

/* =============== Boot =============== */
window.addEventListener("DOMContentLoaded", async ()=>{
  try{
    // Kiểm tra script ethers đã sẵn sàng (do index.html nạp trước app.js) :contentReference[oaicite:9]{index=9}
    if (!window.ethers){ alert("Không tải được ethers.js"); return; }

    await loadAbis();
    initProviders();
    initContractsForRead();

    // Gắn handler Kết nối/Ngắt (đây là chỗ trước đó bạn gặp: nếu JS lỗi sớm, nút sẽ không hoạt động)
    $("#btnConnect")?.addEventListener("click", connectWallet);
    $("#btnDisconnect")?.addEventListener("click", disconnectWallet);

    // Hiển thị giá VIN/VND & sản phẩm
    fetchVinToVND().catch(()=>{});
    await loadAllProducts();
  }catch(e){ console.error("boot", e); }
});
