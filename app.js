/* ====================================================================
   muaban.vin — app.js (ethers v5, fix Internal JSON-RPC error)
   - Legacy tx (type:0 + gasPrice), gasLimit an toàn theo hành động
   - Preflight simulate để hiện rõ revert reason trước khi ký
   - VIN/VND từ nhiều nguồn, tính vinPerVND (wei cho 1 VND)
   - Khớp DOM trong index.html (ethers v5 UMD) và style.css
==================================================================== */

///////////////////////////// Helpers /////////////////////////////////
const $  = (q, r=document)=>r.querySelector(q);
const $$ = (q, r=document)=>Array.from(r.querySelectorAll(q));
const show=el=>{ if(el) el.classList.remove('hidden'); };
const hide=el=>{ if(el) el.classList.add('hidden'); };
const short=a=>a ? a.slice(0,6)+'…'+a.slice(-4) : '';
const alertErr = (tag, err) => {
  console.error(tag, err);
  const msg = parseRevert(err);
  alert(`${tag}\n${msg}`);
};
function parseRevert(err){
  const raw = err?.error?.message || err?.data?.message || err?.reason || err?.message || "";
  const map = {
    NOT_REGISTERED: "Ví chưa đăng ký (bấm ‘Đăng ký’ trước).",
    ALREADY_REGISTERED: "Ví đã đăng ký.",
    PRICE_REQUIRED: "Giá bán (VND) phải > 0.",
    DELIVERY_REQUIRED: "Thời gian giao hàng (ngày) phải ≥ 1.",
    PAYOUT_WALLET_ZERO: "Ví nhận thanh toán không hợp lệ.",
    NOT_SELLER: "Bạn không phải người bán của sản phẩm.",
    PRODUCT_NOT_ACTIVE: "Sản phẩm đang tắt bán.",
    PRODUCT_NOT_FOUND: "Không tìm thấy sản phẩm.",
    QUANTITY_REQUIRED: "Số lượng phải ≥ 1.",
    VIN_PER_VND_REQUIRED: "Tỷ giá chưa sẵn sàng.",
    VIN_TRANSFER_FAIL: "Chuyển VIN thất bại (kiểm tra số dư/allowance).",
    NOT_PLACED: "Trạng thái đơn không hợp lệ.",
    NOT_BUYER: "Chỉ người mua mới thao tác được.",
    NOT_EXPIRED: "Đơn chưa quá hạn giao hàng."
  };
  for (const k in map) if (raw.includes(k)) return map[k];
  const m = /execution reverted(?: with reason string)?:\s*([^\n]+)/i.exec(raw);
  return m ? m[1] : (raw || "Giao dịch bị huỷ hoặc dữ liệu không hợp lệ.");
}
function ipfsToHttp(s){
  if (!s) return "";
  return s.startsWith("ipfs://") ? "https://ipfs.io/ipfs/"+s.slice(7) : s;
}
function parseUnitFromCID(desc){
  const m = /^unit:(.+)$/i.exec(desc||""); return m ? m[1].trim() : "";
}
function encBuyerInfo(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj||{})))); }

///////////////////////////// Config /////////////////////////////////
const CFG = {
  CHAIN_ID: 88,
  RPC: "https://rpc.viction.xyz",
  SCAN: "https://vicscan.xyz",
  MUABAN: "0x190FD18820498872354eED9C4C080cB365Cd12E0",
  VIN:     "0x941F63807401efCE8afe3C9d88d368bAA287Fac4",
  REG_FEE: ethers.BigNumber.from("1000000000000000"), // 0.001 VIN
  GAS_PRICE_GWEI: "50",       // nếu pending lâu có thể nâng 80–120
  GAS_HEAVY: 800000,          // createProduct
  GAS_MED:   400000,          // placeOrder / updateProduct / payRegistration
  GAS_LIGHT: 200000           // approve / confirm / refund
};
// VIN/VND sources
const PRICE_SRC = {
  VIC_VND: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=vnd",
  VIC_USD: "https://api.coingecko.com/api/v3/simple/price?ids=viction&vs_currencies=usd",
  USDT_VND: "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd",
  VICUSDT: "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT"
};

///////////////////////////// State /////////////////////////////////
let providerRead, providerWrite, signer, account;
let muabanR, muabanW, vinR, vinW, MUABAN_ABI, VIN_ABI;
let isRegistered = false;
let vinVND = 0;                         // 1 VIN = ? VND (floor)
let vinPerVNDWei = ethers.BigNumber.from(0); // wei cho 1 VND (ceil)
let products = []; // [{pid, data}]

///////////////////////////// Init /////////////////////////////////
(async function boot(){
  // Providers
  providerRead = new ethers.providers.JsonRpcProvider(CFG.RPC);
  if (window.ethereum) providerWrite = new ethers.providers.Web3Provider(window.ethereum, "any");

  // ABIs
  MUABAN_ABI = await fetch("Muaban_ABI.json").then(r=>r.json());
  VIN_ABI    = await fetch("VinToken_ABI.json").then(r=>r.json());

  // Read contracts
  muabanR = new ethers.Contract(CFG.MUABAN, MUABAN_ABI, providerRead);
  vinR    = new ethers.Contract(CFG.VIN, VIN_ABI, providerRead);

  // UI binds
  bindUI();

  // Public load
  await Promise.all([loadVinPrice(), loadProductsByEvents()]);
})().catch(console.error);

function bindUI(){
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnDisconnect")?.addEventListener("click", ()=>location.reload());

  $("#btnSearch")?.addEventListener("click", doSearch);

  $("#btnRegister")?.addEventListener("click", onRegister);
  $("#btnCreate")?.addEventListener("click", openCreateForm);
  $("#btnOrdersBuy")?.addEventListener("click", ()=>{ show($("#ordersBuySection")); hide($("#ordersSellSection")); });
  $("#btnOrdersSell")?.addEventListener("click", ()=>{ show($("#ordersSellSection")); hide($("#ordersBuySection")); });

  // Create form
  $("#formCreate .close")?.addEventListener("click", ()=> hide($("#formCreate")));
  $("#btnSubmitCreate")?.addEventListener("click", submitCreate);

  // Update form
  $("#formUpdate .close")?.addEventListener("click", ()=> hide($("#formUpdate")));
  $("#btnSubmitUpdate")?.addEventListener("click", submitUpdate);

  // Buy form
  $("#formBuy .close")?.addEventListener("click", ()=> hide($("#formBuy")));
  $("#buyQty")?.addEventListener("input", recalcBuyTotal);
}

///////////////////////////// Wallet ///////////////////////////////
async function connectWallet(){
  try{
    if (!providerWrite) { alert("Vui lòng cài MetaMask."); return; }
    await providerWrite.send("eth_requestAccounts", []);
    const net = await providerWrite.getNetwork();
    if (Number(net.chainId)!==CFG.CHAIN_ID){ alert("Sai mạng. Chọn Viction (chainId=88)."); return; }
    signer = providerWrite.getSigner();
    account = (await signer.getAddress()).toLowerCase();

    muabanW = muabanR.connect(signer);
    vinW    = vinR.connect(signer);

    hide($("#btnConnect")); show($("#walletBox"));
    $("#accountShort").textContent = short(account);
    $("#accountShort").href = `${CFG.SCAN}/address/${account}`;

    const [vinBal, vicBal, reg] = await Promise.all([
      vinR.balanceOf(account),
      providerWrite.getBalance(account),
      muabanR.registered(account)
    ]);
    $("#vinBalance").textContent = `VIN: ${parseFloat(ethers.utils.formatUnits(vinBal,18)).toFixed(4)}`;
    $("#vicBalance").textContent = `VIC: ${parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4)}`;
    isRegistered = reg;
    refreshMenu();

  }catch(e){ alertErr("Kết nối ví thất bại", e); }
}
function refreshMenu(){
  if (!account){
    show($("#btnRegister")); $("#btnRegister").disabled = true;
    hide($("#btnCreate")); hide($("#btnOrdersBuy")); hide($("#btnOrdersSell"));
    return;
  }
  if (!isRegistered){
    show($("#btnRegister")); $("#btnRegister").disabled = false;
    hide($("#btnCreate")); hide($("#btnOrdersBuy")); hide($("#btnOrdersSell"));
  }else{
    hide($("#btnRegister"));
    show($("#btnCreate")); show($("#btnOrdersBuy")); show($("#btnOrdersSell"));
  }
}

///////////////////////////// Pricing //////////////////////////////
async function loadVinPrice(){
  try{
    // 1) trực tiếp VIC→VND
    let vicVnd = 0;
    try{
      const j = await (await fetch(PRICE_SRC.VIC_VND)).json();
      vicVnd = Number(j?.viction?.vnd||0);
    }catch(_){}
    if (vicVnd>0){
      vinVND = Math.floor(vicVnd * 100);                // 1 VIN = 100 VIC
    }else{
      // 2) VIC→USD × USDT→VND
      const [a,b] = await Promise.all([
        fetch(PRICE_SRC.VIC_USD).then(r=>r.json()).catch(()=>({})),
        fetch(PRICE_SRC.USDT_VND).then(r=>r.json()).catch(()=>({}))
      ]);
      const vicUsd = Number(a?.viction?.usd||0);
      const usdtVnd= Number(b?.tether?.vnd||0);
      if (vicUsd>0 && usdtVnd>0) vinVND = Math.floor(vicUsd * 100 * usdtVnd);
      if (!vinVND){
        // 3) Binance fallback
        const [c,d] = await Promise.all([
          fetch(PRICE_SRC.VICUSDT).then(r=>r.json()).catch(()=>({})),
          fetch(PRICE_SRC.USDT_VND).then(r=>r.json()).catch(()=>({}))
        ]);
        const vicUsdt = Number(c?.price||0);
        const usdtVnd2= Number(d?.tether?.vnd||0);
        if (vicUsdt>0 && usdtVnd2>0) vinVND = Math.floor(vicUsdt * 100 * usdtVnd2);
      }
    }
    if (vinVND<=0) throw new Error("Không lấy được giá");
    const ONE = ethers.BigNumber.from("1000000000000000000");
    vinPerVNDWei = ONE.div(vinVND);
    if (ONE.mod(vinVND).gt(0)) vinPerVNDWei = vinPerVNDWei.add(1); // ceil
    $("#vinPrice").textContent = `1 VIN = ${vinVND.toLocaleString("vi-VN")} VND`;
  }catch(e){
    console.warn("loadVinPrice:", e);
    $("#vinPrice").textContent = "Đang tải giá…";
  }
}

///////////////////////////// Products /////////////////////////////
async function loadProductsByEvents(){
  try{
    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const topic = iface.getEventTopic("ProductCreated");
    const logs = await providerRead.getLogs({ address: CFG.MUABAN, fromBlock: 0, toBlock: "latest", topics: [topic] });
    const ids = new Set();
    logs.forEach(l=>{ try{ ids.add(iface.parseLog(l).args.productId.toString()); }catch(_){}});

    products = [];
    for (const pid of Array.from(ids).sort((a,b)=>Number(a)-Number(b))){
      const p = await muabanR.getProduct(pid);
      products.push({ pid: Number(pid), data: p });
    }
    renderProducts(products);
  }catch(e){ console.error("loadProductsByEvents:", e); }
}
function renderProducts(list){
  const wrap = $("#productList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!list.length){ wrap.innerHTML = `<div class="order-row">Chưa có sản phẩm.</div>`; return; }

  list.forEach(({pid, data})=>{
    const unit = parseUnitFromCID(data.descriptionCID);
    const img = ipfsToHttp(data.imageCID);
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <img class="product-thumb" src="${img}" onerror="this.src='https://via.placeholder.com/112x90?text=IPFS'"/>
      <div class="product-info">
        <div class="product-top">
          <h3 class="product-title">${data.name}</h3>
          <span class="badge mono">#${pid}</span>
        </div>
        <div class="product-meta">
          <span class="price-vnd">${Number(data.priceVND).toLocaleString('vi-VN')} VND</span>
          <span class="unit">/ ${unit || 'đv'}</span>
        </div>
        <div class="order-row">
          <span class="stock-badge ${data.active?'':'out'}">${data.active?'Còn hàng':'Hết hàng'}</span>
          <span class="tag">Giao tối đa ${data.deliveryDaysMax} ngày</span>
        </div>
        <div class="card-actions"></div>
      </div>`;
    const actions = card.querySelector(".card-actions");

    if (account){
      if (String(data.seller).toLowerCase() === account.toLowerCase()){
        const b = btn("Cập nhật sản phẩm", ()=> openUpdateForm(pid, data));
        actions.appendChild(b);
      } else if (isRegistered && data.active){
        const b = btn("Mua", ()=> openBuyForm(pid, data));
        b.classList.add("primary");
        actions.appendChild(b);
      }
    }
    wrap.appendChild(card);
  });
}
function btn(text, onClick){
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = text;
  b.onclick = onClick;
  return b;
}
function doSearch(){
  const q = ($("#searchInput")?.value||"").trim().toLowerCase();
  if (!q) { renderProducts(products); return; }
  renderProducts(products.filter(({data})=> (data.name||"").toLowerCase().includes(q)));
}

///////////////////////////// Create / Update ///////////////////////
function openCreateForm(){
  if (!isRegistered){ alert("Ví chưa đăng ký."); return; }
  $("#createName").value = "";
  $("#createIPFS").value = "";
  $("#createUnit").value = "";
  $("#createPrice").value = "";
  $("#createWallet").value = account || "";
  $("#createDays").value = "3";
  show($("#formCreate"));
}
async function submitCreate(){
  try{
    if (!signer) { alert("Hãy kết nối ví."); return; }
    const name = ($("#createName").value||"").trim();
    const ipfs = ($("#createIPFS").value||"").trim();
    const unit = ($("#createUnit").value||"").trim();
    const price = Number($("#createPrice").value||0);
    const wallet= ($("#createWallet").value||"").trim();
    const days  = Number($("#createDays").value||0);
    if (!name || !ipfs || !unit || !price || !wallet || !days){ alert("Nhập đủ thông tin."); return; }

    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const priceVND = ethers.BigNumber.from(String(Math.floor(price)));

    // Preflight
    const txData = await muabanW.populateTransaction.createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, true
    );
    txData.from = await signer.getAddress();
    await providerWrite.call(txData); // sẽ throw nếu revert

    // Send (legacy)
    const tx = await muabanW.createProduct(
      name, descriptionCID, imageCID, priceVND, days, wallet, true,
      await legacyOverrides("heavy")
    );
    await tx.wait();

    hide($("#formCreate"));
    await loadProductsByEvents();
    alert("Đăng sản phẩm thành công.");
  }catch(e){ alertErr("Đăng sản phẩm lỗi", e); }
}
function openUpdateForm(pid, data){
  $("#updatePid").value = String(pid);
  $("#updatePrice").value = Number(data.priceVND||0);
  $("#updateDays").value = Number(data.deliveryDaysMax||1);
  $("#updateWallet").value = data.payoutWallet || "";
  $("#updateActive").checked = !!data.active;
  show($("#formUpdate"));
}
async function submitUpdate(){
  try{
    const pid = Number($("#updatePid").value||0);
    const price = Number($("#updatePrice").value||0);
    const days  = Number($("#updateDays").value||0);
    const wallet= ($("#updateWallet").value||"").trim();
    const active= $("#updateActive").checked;
    if (!pid || !price || !days || !wallet){ alert("Thiếu dữ liệu."); return; }

    const priceVND = ethers.BigNumber.from(String(Math.floor(price)));

    const txData = await muabanW.populateTransaction.updateProduct(pid, priceVND, days, wallet, active);
    txData.from = await signer.getAddress();
    await providerWrite.call(txData);

    const tx = await muabanW.updateProduct(pid, priceVND, days, wallet, active, await legacyOverrides("med"));
    await tx.wait();

    hide($("#formUpdate"));
    await loadProductsByEvents();
    alert("Cập nhật xong.");
  }catch(e){ alertErr("Cập nhật lỗi", e); }
}

///////////////////////////// Register //////////////////////////////
async function onRegister(){
  try{
    if (!signer) { alert("Hãy kết nối ví."); return; }

    // ensure allowance
    const allow = await vinR.allowance(await signer.getAddress(), CFG.MUABAN);
    if (allow.lt(CFG.REG_FEE)){
      const txA = await vinW.approve(CFG.MUABAN, CFG.REG_FEE, await legacyOverrides("light"));
      await txA.wait();
    }

    // preflight
    const txData = await muabanW.populateTransaction.payRegistration();
    txData.from = await signer.getAddress();
    await providerWrite.call(txData);

    // send
    const tx = await muabanW.payRegistration(await legacyOverrides("med"));
    await tx.wait();

    isRegistered = true;
    refreshMenu();
    alert("Đăng ký thành công.");
  }catch(e){ alertErr("Đăng ký lỗi", e); }
}

///////////////////////////// Buy /////////////////////////////////
function openBuyForm(pid, p){
  $("#buyPid").value = String(pid);
  $("#buyName").textContent = p.name || "";
  $("#buyUnit").textContent = parseUnitFromCID(p.descriptionCID) || "đv";
  $("#buyPrice").textContent = Number(p.priceVND).toLocaleString("vi-VN");
  $("#buyQty").value = 1;
  recalcBuyTotal();
  show($("#formBuy"));
}
function recalcBuyTotal(){
  const qty = Math.max(1, Number($("#buyQty").value||1));
  const priceVND = Number($("#buyPrice").textContent.replace(/[^\d]/g,"")||0);
  if (!vinVND) { $("#buyTotalVin").textContent = "—"; return; }
  const totalVIN = (priceVND * qty) / vinVND;
  $("#buyTotalVin").textContent = totalVIN.toFixed(6);
}
$("#btnSubmitBuy")?.addEventListener("click", placeOrder);
async function placeOrder(){
  try{
    if (!signer) { alert("Hãy kết nối ví."); return; }
    if (vinPerVNDWei.isZero()) { alert("Chưa có tỷ giá."); return; }

    const pid = Number($("#buyPid").value||0);
    const fullname = ($("#buyFullname").value||"").trim();
    const phone    = ($("#buyPhone").value||"").trim();
    const address  = ($("#buyAddress").value||"").trim();
    const note     = ($("#buyNote").value||"").trim();
    const qty      = Math.max(1, Number($("#buyQty").value||1));
    if (!pid || !fullname || !phone || !address){ alert("Điền đủ Họ tên, SĐT, Địa chỉ."); return; }

    // Tính vinAmount ước tính để approve
    const prod = await muabanR.getProduct(pid);
    const totalVND = ethers.BigNumber.from(String(Number(prod.priceVND) * qty));
    const vinAmt   = totalVND.mul(vinPerVNDWei); // hợp đồng dùng _ceilDiv => đây đã là ceil

    // ensure allowance đủ
    const allow = await vinR.allowance(await signer.getAddress(), CFG.MUABAN);
    if (allow.lt(vinAmt)){
      const txA = await vinW.approve(CFG.MUABAN, vinAmt, await legacyOverrides("light"));
      await txA.wait();
    }

    const cipher = encBuyerInfo({ fullname, phone, address, note });

    // preflight
    const txData = await muabanW.populateTransaction.placeOrder(pid, qty, vinPerVNDWei, cipher);
    txData.from = await signer.getAddress();
    await providerWrite.call(txData);

    // send
    const tx = await muabanW.placeOrder(pid, qty, vinPerVNDWei, cipher, await legacyOverrides("med"));
    await tx.wait();

    hide($("#formBuy"));
    alert("Đặt hàng thành công.");
  }catch(e){ alertErr("Đặt hàng lỗi", e); }
}

///////////////////////////// Misc /////////////////////////////////
function legacyOverrides(kind){
  const gasPrice = ethers.utils.parseUnits(CFG.GAS_PRICE_GWEI, "gwei");
  const gasLimit =
    kind==="heavy" ? CFG.GAS_HEAVY :
    kind==="light" ? CFG.GAS_LIGHT : CFG.GAS_MED;
  return { type: 0, gasPrice, gasLimit };
}
