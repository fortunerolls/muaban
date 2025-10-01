/* ============================================================
   muaban.vin — app.js (Ethers v5 UMD)
   - Kết nối ví + đảm bảo mạng Viction (chainId 88)
   - Hiển thị số dư VIC/VIN, giá 1 VIN theo VND
   - Đăng ký ví (0.001 VIN) với approve tự động
   - Đăng / Cập nhật sản phẩm
   - Mua hàng (approve -> placeOrder)
   - Quản lý hiển thị UI theo trạng thái đăng ký
   - Lưu đơn hàng cục bộ (localStorage) để xem lại "Đơn mua/Đơn bán"
   ------------------------------------------------------------
   Lưu ý:
   * Hợp đồng không có hàm liệt kê tất cả sản phẩm → phần "Danh sách sản phẩm"
     sẽ hiển thị thông báo khi chưa có indexer. Bạn vẫn có thể:
       - Lấy sản phẩm của chính mình qua getSellerProductIds(address)
       - Xem / thêm đơn hàng của chính mình (lưu cục bộ sau khi mua)
   ============================================================ */

/* -------------------- 0) Hằng số & Tham số -------------------- */
// Chain & Explorer
const VIC_CHAIN_ID_DEC = 88;
const VIC_CHAIN_ID_HEX = "0x58";
const RPC_URL = "https://rpc.viction.xyz";
const EXPLORER = "https://www.vicscan.xyz";

// Địa chỉ hợp đồng (theo mô tả & index.html/footer)
const MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
const VIN_ADDR     = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";

// Nguồn tỷ giá (client-side):
// 1) VIC/USDT từ Binance
const BINANCE_TICKER = "https://api.binance.com/api/v3/ticker/price?symbol=VICUSDT";
// 2) USDT/VND từ CoinGecko (dùng đơn giản: 1 USDT ≈ VND theo thị trường VN)
//   CoinGecko simple price: /simple/price?ids=tether&vs_currencies=vnd
const COINGECKO_USDT_VND = "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=vnd";

// Quy đổi: 1 VIN = 100 VIC  ⇒  VIN/VND = (VIC/USDT * 100) * (USDT/VND)
// Từ đó tính vinPerVNDWei = 1e18 / (VIN/VND)
let VIN_PER_VND_WEI = null; // BigNumber string (wei/VND) để truyền vào placeOrder

// Ethers objects
let provider = null;
let signer   = null;

// Contract instances (ethers v5)
let muaban = null;
let vinErc20 = null;

// DOM elements
const $btnConnect      = document.getElementById("btnConnect");
const $btnDisconnect   = document.getElementById("btnDisconnect");
const $walletBox       = document.getElementById("walletBox");
const $vinBal          = document.getElementById("vinBalance");
const $vicBal          = document.getElementById("vicBalance");
const $accountShort    = document.getElementById("accountShort");
const $menuBox         = document.getElementById("menuBox");
const $btnRegister     = document.getElementById("btnRegister");
const $btnCreate       = document.getElementById("btnCreate");
const $btnOrdersBuy    = document.getElementById("btnOrdersBuy");
const $btnOrdersSell   = document.getElementById("btnOrdersSell");
const $vinPriceChip    = document.getElementById("vinPrice");

const $formCreate      = document.getElementById("formCreate");
const $formUpdate      = document.getElementById("formUpdate");
const $formBuy         = document.getElementById("formBuy");

const $productList     = document.getElementById("productList");
const $ordersBuySec    = document.getElementById("ordersBuySection");
const $ordersSellSec   = document.getElementById("ordersSellSection");
const $ordersBuyList   = document.getElementById("ordersBuyList");
const $ordersSellList  = document.getElementById("ordersSellList");

// Create form fields
const $createName   = document.getElementById("createName");
const $createIPFS   = document.getElementById("createIPFS");
const $createUnit   = document.getElementById("createUnit");  // UI-only
const $createPrice  = document.getElementById("createPrice");
const $createWallet = document.getElementById("createWallet");
const $createDays   = document.getElementById("createDays");

// Update form fields
const $updatePid    = document.getElementById("updatePid");
const $updatePrice  = document.getElementById("updatePrice");
const $updateDays   = document.getElementById("updateDays");
const $updateWallet = document.getElementById("updateWallet");
const $updateActive = document.getElementById("updateActive");

// Buy form fields
const $buyProductInfo = document.getElementById("buyProductInfo");
const $buyName        = document.getElementById("buyName");
const $buyAddress     = document.getElementById("buyAddress");
const $buyPhone       = document.getElementById("buyPhone");
const $buyNote        = document.getElementById("buyNote");
const $buyQty         = document.getElementById("buyQty");
const $buyTotalVIN    = document.getElementById("buyTotalVIN");

// Nút hành động trong modals
const $btnSubmitCreate = document.getElementById("btnSubmitCreate");
const $btnSubmitUpdate = document.getElementById("btnSubmitUpdate");
const $btnSubmitBuy    = document.getElementById("btnSubmitBuy");

// Tìm kiếm (hiện tại chưa dùng indexer on-chain → để dành)
const $btnSearch   = document.getElementById("btnSearch");
const $searchInput = document.getElementById("searchInput");

// Local state
let currentAccount = null;
let isRegistered   = false;

// Minimal toast (thân thiện)
function toast(msg, type="info"){
  const el = document.createElement("div");
  el.textContent = msg;
  el.style.position = "fixed";
  el.style.zIndex = 9999;
  el.style.left = "50%";
  el.style.top  = "14px";
  el.style.transform = "translateX(-50%)";
  el.style.padding = "10px 14px";
  el.style.borderRadius = "10px";
  el.style.fontWeight = "700";
  el.style.background = type==="error" ? "#fee2e2" : type==="warn" ? "#fef9c3" : "#dcfce7";
  el.style.border = "1px solid #e5e7eb";
  el.style.boxShadow = "0 6px 16px rgba(2,6,23,.08)";
  el.style.color = "#0f172a";
  document.body.appendChild(el);
  setTimeout(()=> el.remove(), 2400);
}
function short(addr){
  return addr ? addr.slice(0,6)+"…"+addr.slice(-4) : "0x…";
}

// Lock scroll when modal open
function openModal($el){
  $el.classList.remove("hidden");
  document.body.classList.add("no-scroll");
}
function closeModal($el){
  $el.classList.add("hidden");
  document.body.classList.remove("no-scroll");
}
document.querySelectorAll(".modal .close").forEach(btn=>{
  btn.addEventListener("click", ()=> closeModal(btn.closest(".modal")));
});

/* -------------------- 1) Kết nối ví + network -------------------- */
async function ensureViction(){
  if(!window.ethereum) return false;
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (chainId === VIC_CHAIN_ID_HEX) return true;
  try{
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: VIC_CHAIN_ID_HEX }]
    });
    return true;
  }catch(err){
    if(err && err.code===4902){
      try{
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: "Viction Mainnet",
            nativeCurrency: { name:"VIC", symbol:"VIC", decimals:18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: [EXPLORER]
          }]
        });
        return true;
      }catch(e){ return false; }
    }
    return false;
  }
}

async function connect(){
  if(!window.ethereum){ toast("Không tìm thấy ví. Hãy cài MetaMask.", "warn"); return; }
  try{
    provider = new ethers.providers.Web3Provider(window.ethereum, "any"); // v5
    await provider.send("eth_requestAccounts", []);
    const ok = await ensureViction();
    if(!ok){ toast("Vui lòng chuyển sang mạng Viction.", "warn"); return; }

    signer = provider.getSigner();
    currentAccount = await signer.getAddress();

    // Khởi tạo contract
    muaban  = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
    vinErc20= new ethers.Contract(VIN_ADDR, VIN_ABI, signer);

    // Cập nhật UI
    $btnConnect.classList.add("hidden");
    $walletBox.classList.remove("hidden");
    $accountShort.href = `${EXPLORER}/address/${currentAccount}`;
    $accountShort.textContent = short(currentAccount);

    // Sự kiện account/network thay đổi
    window.ethereum.removeAllListeners?.("accountsChanged");
    window.ethereum.on?.("accountsChanged", ()=> location.reload());
    window.ethereum.on?.("chainChanged", ()=> location.reload());

    await refreshBalances();
    await refreshRegistrationUI();
    await tickPriceChip(); // cập nhật giá VIN/VND

    // Thông báo
    toast("Đã kết nối ví.");
  }catch(err){
    console.error(err);
    toast("Kết nối ví thất bại.", "error");
  }
}
function disconnect(){
  // Chỉ ẩn UI client, không thể "ngắt" ví từ dApp
  currentAccount = null;
  signer = null;
  provider = null;
  muaban = null;
  vinErc20 = null;

  $btnConnect.classList.remove("hidden");
  $walletBox.classList.add("hidden");
  $menuBox.classList.add("hidden");
  $ordersBuySec.classList.add("hidden");
  $ordersSellSec.classList.add("hidden");
  toast("Đã ẩn thông tin ví.");
}

$btnConnect?.addEventListener("click", connect);
$btnDisconnect?.addEventListener("click", disconnect);

/* -------------------- 2) Giá VIN/VND -------------------- */
async function tickPriceChip(){
  try{
    $vinPriceChip.textContent = "Loading price...";
    // 1) Lấy VIC/USDT
    const r1 = await fetch(BINANCE_TICKER, { cache: "no-store" });
    const j1 = await r1.json();
    const vic_usdt = Number(j1?.price || "0"); // số thực

    // 2) Lấy USDT/VND
    const r2 = await fetch(COINGECKO_USDT_VND, { cache: "no-store" });
    const j2 = await r2.json();
    const usdt_vnd = Number(j2?.tether?.vnd || "0");

    if(!vic_usdt || !usdt_vnd) throw new Error("Price source unavailable");

    // 3) VIN/VND
    const vin_vnd = vic_usdt * 100 * usdt_vnd; // 1 VIN = 100 VIC
    // 4) Wei per 1 VND
    // vinPerVNDWei = 1e18 / (vin_vnd)  (làm tròn lên để bảo vệ người bán khi placeOrder)
    const ONE = ethers.BigNumber.from("1000000000000000000"); // 1e18
    const vinVndStr = vin_vnd.toString();
    // Tránh số thực: scale × 1e6
    const SCALE = ethers.BigNumber.from("1000000");
    const vinVndScaled = ethers.BigNumber.from(Math.floor(vin_vnd * 1e6).toString()); // VND × 1e6
    const perVndWei = ONE.mul(SCALE).add(vinVndScaled).sub(1).div(vinVndScaled); // ceil(1e18 / vin_vnd)
    VIN_PER_VND_WEI = perVndWei.toString();

    // Hiển thị chip
    const pretty = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(vin_vnd);
    $vinPriceChip.textContent = `1 VIN = ${pretty} VND`;
  }catch(e){
    console.warn("tickPriceChip error:", e);
    $vinPriceChip.textContent = "Không lấy được giá";
  }
}
// Cập nhật định kỳ 60s
setInterval(()=> {
  if(currentAccount) tickPriceChip();
}, 60000);

/* -------------------- 3) Số dư ví -------------------- */
async function refreshBalances(){
  if(!provider || !currentAccount) return;
  try{
    const vic = await provider.getBalance(currentAccount);
    $vicBal.textContent = "VIC: " + ethers.utils.formatEther(vic);

    if(!vinErc20){
      const readProv = new ethers.providers.JsonRpcProvider(RPC_URL);
      vinErc20 = new ethers.Contract(VIN_ADDR, VIN_ABI, readProv);
    }
    const vinBal = await vinErc20.balanceOf(currentAccount);
    $vinBal.textContent = "VIN: " + ethers.utils.formatEther(vinBal);
  }catch(e){
    console.warn("refreshBalances:", e);
  }
}

/* -------------------- 4) Trạng thái đăng ký -------------------- */
async function isUserRegistered(addr){
  try{
    const readProv = provider ?? new ethers.providers.JsonRpcProvider(RPC_URL);
    const mm = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, readProv);
    return await mm.registered(addr);
  }catch(e){
    return false;
  }
}
async function refreshRegistrationUI(){
  if(!currentAccount) return;
  isRegistered = await isUserRegistered(currentAccount);
  $menuBox.classList.remove("hidden");
  if(isRegistered){
    $btnRegister.classList.add("hidden");
    $btnCreate.classList.remove("hidden");
    $btnOrdersBuy.classList.remove("hidden");
    $btnOrdersSell.classList.remove("hidden");
  }else{
    $btnRegister.classList.remove("hidden");
    $btnCreate.classList.add("hidden");
    $btnOrdersBuy.classList.add("hidden");
    $btnOrdersSell.classList.add("hidden");
  }
}

/* -------------------- 5) Approve helper -------------------- */
async function ensureAllowance(spender, neededWei){
  const owner = currentAccount;
  const allowance = await vinErc20.allowance(owner, spender);
  if(allowance.gte(neededWei)) return true;
  try{
    const tx = await vinErc20.connect(signer).approve(spender, neededWei);
    toast("Đang approve VIN…");
    await tx.wait();
    return true;
  }catch(e){
    console.error(e);
    toast("Approve VIN bị từ chối.", "error");
    return false;
  }
}

/* -------------------- 6) Đăng ký ví (0.001 VIN) -------------------- */
$btnRegister?.addEventListener("click", async ()=>{
  if(!signer) { toast("Hãy kết nối ví trước.", "warn"); return; }
  try{
    // Lấy REG_FEE từ contract để chắc chắn
    const regFee = await muaban.REG_FEE(); // 1e15 wei (0.001 VIN)
    // Approve cho contract
    const ok = await ensureAllowance(MUABAN_ADDR, regFee);
    if(!ok) return;
    // Gọi payRegistration()
    const tx = await muaban.payRegistration();
    toast("Đang đăng ký ví…");
    await tx.wait();
    toast("Đăng ký thành công!");
    await refreshRegistrationUI();
    await refreshBalances();
  }catch(e){
    console.error(e);
    toast("Đăng ký thất bại. (Kiểm tra số dư VIN & phí gas)", "error");
  }
});

/* -------------------- 7) Đăng sản phẩm -------------------- */
$btnCreate?.addEventListener("click", ()=>{
  if(!isRegistered){ toast("Bạn cần đăng ký ví trước.", "warn"); return; }
  // reset form
  $createName.value = "";
  $createIPFS.value = "";
  $createUnit.value = "";
  $createPrice.value = "";
  $createWallet.value = currentAccount || "";
  $createDays.value = "3";
  openModal($formCreate);
});

document.getElementById("btnSubmitCreate")?.addEventListener("click", async ()=>{
  try{
    if(!signer) { toast("Hãy kết nối ví trước.", "warn"); return; }
    if(!isRegistered){ toast("Bạn cần đăng ký ví trước.", "warn"); return; }

    const name   = ($createName.value||"").trim();
    const ipfs   = ($createIPFS.value||"").trim();
    const unit   = ($createUnit.value||"").trim(); // UI only – gắn vào descriptionCID
    const price  = ethers.BigNumber.from(($createPrice.value||"0").toString());
    const wallet = ($createWallet.value||"").trim();
    const days   = Number($createDays.value||"0");

    if(!name || name.length>500){ toast("Tên sản phẩm phải có (≤500 ký tự).", "warn"); return; }
    if(price.lte(0)){ toast("Giá bán (VND) > 0.", "warn"); return; }
    if(!wallet.startsWith("0x") || wallet.length!==42){ toast("Ví nhận thanh toán không hợp lệ.", "warn"); return; }
    if(!days || days<=0){ toast("Thời gian giao hàng (ngày) > 0.", "warn"); return; }

    // Ghép unit vào descriptionCID để người bán nhớ đơn vị
    const descriptionCID = unit ? `UNIT:${unit}` : "";
    const imageCID = ipfs; // cho phép ipfs://CID hoặc https://ipfs.io/ipfs/CID

    const tx = await muaban.createProduct(
      name,
      descriptionCID,
      imageCID,
      price.toString(),
      days,
      wallet,
      true // active
    );
    toast("Đang tạo sản phẩm…");
    const rc = await tx.wait();
    // Cố gắng đọc ProductCreated để lấy pid (tuỳ node có log hay không)
    let pid = null;
    try{
      const ev = rc.events?.find(e=> e.event==="ProductCreated");
      if(ev && ev.args?.productId) pid = ev.args.productId.toString();
    }catch{}

    closeModal($formCreate);
    toast(pid ? `Đã đăng sản phẩm #${pid}.` : "Đã đăng sản phẩm.");
  }catch(e){
    console.error(e);
    // Thông báo thân thiện (tránh "Internal JSON-RPC error")
    toast("Không thể đăng sản phẩm: vui lòng kiểm tra: đã kết nối ví, đúng mạng Viction, đủ VIC gas, đã Đăng ký ví.", "error");
  }
});

/* -------------------- 8) Cập nhật sản phẩm -------------------- */
// Hiện modal cập nhật (yêu cầu người bán nhập pid thủ công do chưa có indexer)
$btnOrdersSell?.addEventListener("click", ()=>{
  // Mở danh sách đơn bán (localStorage) thay vì sản phẩm
  renderSellOrdersLocal();
  $ordersSellSec.classList.remove("hidden");
  $ordersBuySec.classList.add("hidden");
});

document.getElementById("btnSubmitUpdate")?.addEventListener("click", async ()=>{
  if(!signer){ toast("Hãy kết nối ví.", "warn"); return; }
  const pidStr = ($updatePid.value||"").trim();
  if(!pidStr) { toast("Nhập Product ID.", "warn"); return; }
  try{
    const pid    = ethers.BigNumber.from(pidStr);
    const price  = ethers.BigNumber.from(($updatePrice.value||"0").toString());
    const days   = Number($updateDays.value||"0");
    const wallet = ($updateWallet.value||"").trim();
    const active = !!$updateActive.checked;

    if(price.lte(0))       { toast("Giá bán (VND) > 0.", "warn"); return; }
    if(!days || days<=0)   { toast("Thời gian giao hàng > 0.", "warn"); return; }
    if(!wallet.startsWith("0x") || wallet.length!==42){ toast("Ví nhận thanh toán không hợp lệ.", "warn"); return; }

    const tx = await muaban.updateProduct(
      pid.toString(),
      price.toString(),
      days,
      wallet,
      active
    );
    toast("Đang cập nhật sản phẩm…");
    await tx.wait();
    closeModal($formUpdate);
    toast(`Đã cập nhật sản phẩm #${pidStr}.`);
  }catch(e){
    console.error(e);
    toast("Cập nhật thất bại. Kiểm tra quyền người bán, phí gas, dữ liệu.", "error");
  }
});

/* -------------------- 9) Mua sản phẩm -------------------- */
// Do không có indexer/liệt kê, cho phép người mua nhập pid thủ công khi bấm Mua.
// Ở UI chính, bạn có thể thêm nút để nhập pid và mở formBuy.
// Tại đây ta cung cấp helper mở formBuy theo pid:
async function openBuyForPid(pid){
  if(!VIN_PER_VND_WEI){ await tickPriceChip(); }
  try{
    const readProv = provider ?? new ethers.providers.JsonRpcProvider(RPC_URL);
    const mm = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, readProv);
    const p  = await mm.getProduct(pid);
    if(!p || !p.seller || p.seller==="0x0000000000000000000000000000000000000000"){
      toast("Không tìm thấy sản phẩm.", "warn"); return;
    }
    if(!p.active){ toast("Sản phẩm đang tạm dừng bán.", "warn"); return; }

    // Render thông tin tóm tắt
    $buyProductInfo.innerHTML = `
      <div class="product-brief">
        <div><b>PID:</b> #${p.productId}</div>
        <div><b>Tên:</b> ${escapeHtml(p.name||"")}</div>
        <div><b>Giá:</b> ${fmtVND(p.priceVND)} VND</div>
        <div><b>Giao hàng:</b> ${p.deliveryDaysMax} ngày</div>
      </div>`;
    $buyQty.value = "1";
    $buyTotalVIN.textContent = "Tổng VIN cần trả: 0";
    openModal($formBuy);

    // Lưu pid vào dataset để submit
    $formBuy.dataset.pid = p.productId.toString();
    // Cập nhật tổng VIN khi thay đổi qty
    $buyQty.oninput = ()=>{
      try{
        const qty  = Math.max(1, parseInt($buyQty.value||"1",10));
        const totalVnd = ethers.BigNumber.from(p.priceVND.toString()).mul(qty);
        const weiPerVnd = ethers.BigNumber.from(VIN_PER_VND_WEI);
        const vinWei = ceilDiv(totalVnd.mul(weiPerVnd), ethers.BigNumber.from("1"));
        $buyTotalVIN.textContent = "Tổng VIN cần trả: " + ethers.utils.formatEther(vinWei);
      }catch{
        $buyTotalVIN.textContent = "Tổng VIN cần trả: 0";
      }
    };
    $buyQty.oninput();
  }catch(e){
    console.error(e);
    toast("Không đọc được sản phẩm.", "error");
  }
}
function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtVND(n){
  try{ return new Intl.NumberFormat("vi-VN").format(Number(n)); }catch{ return String(n); }
}
function ceilDiv(a,b){
  // a,b BigNumber
  return a.add(b).sub(1).div(b);
}

// Submit mua
$btnSubmitBuy?.addEventListener("click", async ()=>{
  if(!signer) { toast("Hãy kết nối ví.", "warn"); return; }
  if(!isRegistered){ toast("Bạn cần đăng ký ví trước.", "warn"); return; }
  try{
    const pidStr = $formBuy.dataset.pid;
    if(!pidStr){ toast("Thiếu PID.", "warn"); return; }

    // Lấy lại product để tính vinAmount
    const p = await muaban.getProduct(pidStr);
    const qty = Math.max(1, parseInt($buyQty.value||"1",10));

    const totalVnd = ethers.BigNumber.from(p.priceVND.toString()).mul(qty);
    const weiPerVnd = ethers.BigNumber.from(VIN_PER_VND_WEI || "0");
    if(weiPerVnd.lte(0)){ toast("Không có tỷ giá VIN/VND.", "warn"); return; }
    const vinWei = ceilDiv(totalVnd.mul(weiPerVnd), ethers.BigNumber.from("1"));

    // Mã hóa thông tin người mua (đơn giản: base64 JSON)
    const buyerInfo = {
      name: ($buyName.value||"").trim(),
      address: ($buyAddress.value||"").trim(),
      phone: ($buyPhone.value||"").trim(),
      note: ($buyNote.value||"").trim()
    };
    const buyerInfoCipher = btoa(unescape(encodeURIComponent(JSON.stringify(buyerInfo)))); // mock cipher

    // Approve vinWei cho contract
    const ok = await ensureAllowance(MUABAN_ADDR, vinWei);
    if(!ok) return;

    // Gọi placeOrder(productId, quantity, vinPerVND, buyerInfoCipher)
    const tx = await muaban.placeOrder(
      p.productId.toString(),
      qty,
      weiPerVnd.toString(),
      buyerInfoCipher
    );
    toast("Đang tạo đơn hàng…");
    const rc = await tx.wait();

    // Thử đọc OrderPlaced để lấy orderId
    let oid = null;
    try{
      const ev = rc.events?.find(e=> e.event==="OrderPlaced");
      if(ev && ev.args?.orderId) oid = ev.args.orderId.toString();
    }catch{}
    closeModal($formBuy);
    toast(oid ? `Đặt mua thành công. OID #${oid}` : "Đặt mua thành công.");

    // Lưu cục bộ để hiển thị phần "Đơn mua"
    if(oid){
      pushLocalOrder("buy", {
        orderId: oid,
        productId: p.productId.toString(),
        seller: p.seller,
        buyer: currentAccount,
        quantity: qty,
        vinAmount: vinWei.toString(),
        deadlineDays: Number(p.deliveryDaysMax||0)
      });
      renderBuyOrdersLocal();
    }
    await refreshBalances();
  }catch(e){
    console.error(e);
    toast("Không thể tạo đơn hàng: hãy kiểm tra số dư VIN, approve, phí gas & mạng.", "error");
  }
});

/* -------------------- 10) Đơn hàng: xác nhận/hoàn tiền -------------------- */
function pushLocalOrder(kind, rec){
  const key = kind==="buy" ? "mbv_buy_orders" : "mbv_sell_orders";
  const cur = JSON.parse(localStorage.getItem(key)||"[]");
  cur.unshift({ ...rec, t: Date.now() });
  localStorage.setItem(key, JSON.stringify(cur.slice(0,200)));
}
function renderBuyOrdersLocal(){
  const list = JSON.parse(localStorage.getItem("mbv_buy_orders")||"[]");
  $ordersBuyList.innerHTML = "";
  if(!list.length){
    $ordersBuyList.innerHTML = `<div class="order-card">Chưa có đơn mua nào (cục bộ).</div>`;
    return;
  }
  for(const o of list){
    const row = document.createElement("div");
    row.className = "order-card";
    row.innerHTML = `
      <div class="order-row"><span class="order-strong">OID:</span> ${o.orderId}</div>
      <div class="order-row"><span class="order-strong">PID:</span> ${o.productId}</div>
      <div class="order-row"><span class="order-strong">VIN:</span> ${ethers.utils.formatEther(o.vinAmount)}</div>
      <div class="order-row"><a class="mono" href="${EXPLORER}/address/${o.seller}" target="_blank" rel="noopener">Seller</a></div>
      <div class="card-actions">
        <button class="btn primary" data-act="confirm" data-oid="${o.orderId}">Xác nhận đã nhận hàng</button>
        <button class="btn" data-act="refund" data-oid="${o.orderId}">Hoàn tiền (khi quá hạn)</button>
      </div>`;
    $ordersBuyList.appendChild(row);
  }
  // Gán handler
  $ordersBuyList.querySelectorAll("[data-act='confirm']").forEach(btn=>{
    btn.onclick = async ()=>{
      try{
        const oid = btn.dataset.oid;
        const tx = await muaban.confirmReceipt(oid);
        toast("Đang xác nhận nhận hàng…");
        await tx.wait();
        toast("Đã giải ngân cho người bán.");
        await refreshBalances();
      }catch(e){
        console.error(e);
        toast("Xác nhận thất bại.", "error");
      }
    };
  });
  $ordersBuyList.querySelectorAll("[data-act='refund']").forEach(btn=>{
    btn.onclick = async ()=>{
      try{
        const oid = btn.dataset.oid;
        const tx = await muaban.refundIfExpired(oid);
        toast("Đang yêu cầu hoàn tiền…");
        await tx.wait();
        toast("Đã hoàn tiền (nếu đơn quá hạn).");
        await refreshBalances();
      }catch(e){
        console.error(e);
        toast("Hoàn tiền thất bại (có thể chưa quá hạn).", "error");
      }
    };
  });
}
function renderSellOrdersLocal(){
  const list = JSON.parse(localStorage.getItem("mbv_sell_orders")||"[]");
  $ordersSellList.innerHTML = "";
  if(!list.length){
    $ordersSellList.innerHTML = `<div class="order-card">Chưa có đơn bán nào (cục bộ).</div>`;
    return;
  }
  for(const o of list){
    const row = document.createElement("div");
    row.className = "order-card";
    row.innerHTML = `
      <div class="order-row"><span class="order-strong">OID:</span> ${o.orderId}</div>
      <div class="order-row"><span class="order-strong">PID:</span> ${o.productId}</div>
      <div class="order-row"><span class="order-strong">VIN:</span> ${ethers.utils.formatEther(o.vinAmount)}</div>
      <div class="order-row"><a class="mono" href="${EXPLORER}/address/${o.buyer}" target="_blank" rel="noopener">Buyer</a></div>
    `;
    $ordersSellList.appendChild(row);
  }
}

// Nút menu "Đơn mua"
$btnOrdersBuy?.addEventListener("click", ()=>{
  renderBuyOrdersLocal();
  $ordersBuySec.classList.remove("hidden");
  $ordersSellSec.classList.add("hidden");
});

/* -------------------- 11) Danh sách sản phẩm (placeholder) -------------------- */
function renderProductListPlaceholder(){
  $productList.innerHTML = `
    <div class="product-card">
      <div>
        <img class="product-thumb" alt="" />
      </div>
      <div class="product-info">
        <h3 class="product-title">Chưa có danh sách sản phẩm công khai</h3>
        <div class="product-meta">Hợp đồng hiện chưa hỗ trợ liệt kê tất cả sản phẩm. Bạn có thể nhập PID để mua.</div>
        <div class="card-actions">
          <button class="btn" id="btnOpenBuyByPid">Mua theo PID</button>
          <button class="btn" id="btnOpenUpdate">Cập nhật sản phẩm (seller)</button>
        </div>
      </div>
    </div>
  `;
  // Gán nút mở form buy theo pid
  document.getElementById("btnOpenBuyByPid")?.addEventListener("click", async ()=>{
    const pid = prompt("Nhập Product ID (PID) muốn mua:");
    if(pid) openBuyForPid(pid.trim());
  });
  // Gán nút mở form update
  document.getElementById("btnOpenUpdate")?.addEventListener("click", ()=>{
    if(!isRegistered){ toast("Bạn cần đăng ký ví trước.", "warn"); return; }
    $updatePid.value    = "";
    $updatePrice.value  = "";
    $updateDays.value   = "";
    $updateWallet.value = currentAccount || "";
    $updateActive.checked = true;
    openModal($formUpdate);
  });
}

/* -------------------- 12) Tìm kiếm (placeholder) -------------------- */
$btnSearch?.addEventListener("click", ()=>{
  const q = ($searchInput.value||"").trim();
  if(!q){ toast("Nhập từ khóa tìm kiếm.", "warn"); return; }
  toast("Hiện chưa có indexer, không thể tìm kiếm on-chain.", "warn");
});

/* -------------------- 13) Khởi tạo khi mở trang -------------------- */
(async function init(){
  try{
    renderProductListPlaceholder();
    // Nếu có ví & đã cấp quyền trang trước, tự động connect
    if(window.ethereum && (await window.ethereum.request({ method:"eth_accounts"}))?.length){
      // Không tự động gọi eth_requestAccounts để tránh popup ngoài ý muốn
      provider = new ethers.providers.Web3Provider(window.ethereum, "any");
      const ok = await ensureViction();
      if(ok){
        signer = provider.getSigner();
        currentAccount = await signer.getAddress();

        muaban   = new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer);
        vinErc20 = new ethers.Contract(VIN_ADDR, VIN_ABI, signer);

        $btnConnect.classList.add("hidden");
        $walletBox.classList.remove("hidden");
        $accountShort.href = `${EXPLORER}/address/${currentAccount}`;
        $accountShort.textContent = short(currentAccount);

        window.ethereum.on?.("accountsChanged", ()=> location.reload());
        window.ethereum.on?.("chainChanged", ()=> location.reload());

        await refreshBalances();
        await refreshRegistrationUI();
      }
    }
    // Dù chưa kết nối ví vẫn hiển thị giá (chỉ để tham khảo)
    await tickPriceChip();
  }catch(e){
    console.warn("init error:", e);
  }
})();

/* -------------------- 14) ABIs (nhúng từ file) -------------------- */
// Để build single-file dễ copy, bạn có thể dán trực tiếp ABI (đồng bộ với file JSON)
// Nếu giữ tách file, bạn có thể import bằng cách nhúng <script> trước app.js.
// Ở đây: lấy từ window nếu đã load, nếu không fallback constant (rút gọn).
const MUABAN_ABI = window.MUABAN_ABI || (/* dán nguyên nội dung Muaban_ABI.json tại đây nếu cần */);
const VIN_ABI    = window.VIN_ABI    || (/* dán nguyên nội dung VinToken_ABI.json tại đây nếu cần */);

// Nếu bạn đang dùng <script defer src="app.js"></script> + <script src="...ethers...">,
// hãy chắc chắn 2 file JSON ABI đã được thêm vào trang (ví dụ gán window.MUABAN_ABI, window.VIN_ABI)
/* Ví dụ:
<script>window.MUABAN_ABI = ... nội dung Muaban_ABI.json ...</script>
<script>window.VIN_ABI = ... nội dung VinToken_ABI.json ...</script>
*/
