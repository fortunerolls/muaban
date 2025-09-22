// ========================== app.js ==========================
// DApp Muaban.vin - kết nối VIC Mainnet
// Đầy đủ chức năng: connect ví, đăng ký, đăng sản phẩm, mua hàng,
// hiển thị sản phẩm và đơn hàng, xử lý lỗi JSON-RPC với simulate & decode.

// ===== ethers.js từ window =====
const { ethers } = window.ethers;

// ===== Cấu hình mạng VIC =====
const VIC_CHAIN_ID_HEX = "0x58"; // 88 decimal
const RPC_URL = "https://rpc.viction.xyz";
const EXPLORER = "https://vicscan.xyz";

// ===== Địa chỉ hợp đồng =====
// Nếu muốn override bằng HTML, thêm data-muaban-addr / data-vin-addr vào <body>
const DEFAULT_MUABAN_ADDR = "0x190FD18820498872354eED9C4C080cB365Cd12E0";
const DEFAULT_VIN_ADDR    = "0x941F63807401efCE8afe3C9d88d368bAA287Fac4";
function getAddrFromDOM(id, def){
  try{
    const val = document.body?.dataset?.[id] || "";
    if (val && ethers.utils.isAddress(val)) return val;
  }catch(_){}
  return def;
}
const MUABAN_ADDR = getAddrFromDOM("muabanAddr", DEFAULT_MUABAN_ADDR);
const VIN_ADDR    = getAddrFromDOM("vinAddr", DEFAULT_VIN_ADDR);

// ===== ABI (tải động từ file JSON đặt cùng thư mục) =====
let MUABAN_ABI, VIN_ABI;
(async function loadABIs(){
  try{
    MUABAN_ABI = await (await fetch("Muaban_ABI.json", {cache:"no-store"})).json();
  }catch(e){ console.error("Không tải được Muaban_ABI.json", e); }
  try{
    VIN_ABI    = await (await fetch("VinToken_ABI.json", {cache:"no-store"})).json();
  }catch(e){ console.error("Không tải được VinToken_ABI.json", e); }
})();

// ===== Biến toàn cục =====
let provider, signer, account;

// ===== Helpers =====
function $(sel){ return document.querySelector(sel); }
function toast(msg){ try{ if (window.Toastify) { Toastify({text: msg, duration: 3500}).showToast(); return; } }catch(_){ } alert(msg); }
function cleanIntString(s){ return String(s||"").replace(/[^\d]/g,""); }
function shortAddr(a){ return a ? (a.slice(0,6)+"…"+a.slice(-4)) : ""; }

// Giải mã revert reason
function hexSlice(str, start, end){ return "0x" + (str.startsWith("0x") ? str.slice(2) : str).slice(start*2, end?end*2:undefined); }
function decodeRevertReason(data){
  try{
    if (!data) return "";
    const hex = data.toString();
    // Error(string)
    if (hex.startsWith("0x08c379a0")){
      const raw = "0x" + hex.slice(10);
      const len = parseInt(hexSlice(raw, 32, 64),16);
      const strHex = hexSlice(raw, 64, 64+len);
      return ethers.utils.toUtf8String(strHex);
    }
    // Panic(uint256)
    if (hex.startsWith("0x4e487b71")){
      const codeHex = hexSlice(hex,4,36);
      const code = parseInt(codeHex,16);
      return `Panic(0x${code.toString(16)})`;
    }
    return "";
  }catch(_){ return ""; }
}

async function simulateAndDecode({provider,to,from,data,value}){
  try{
    await provider.call({ to, data, from, value:value||"0x0" });
    return {ok:true};
  }catch(err){
    const raw = err?.data?.data || err?.data || err?.error?.data || err?.error?.data?.originalError?.data || err?.reason || err?.message;
    const reason = typeof raw==="string" ? decodeRevertReason(raw) : "";
    return {ok:false, raw:err, reason: reason || (err?.message||"")};
  }
}

// ===== Đảm bảo kết nối mạng VIC =====
async function ensureViction(){
  const eth = window.ethereum;
  if (!eth) throw new Error("Không thấy ví Ethereum.");
  const cid = await eth.request({method:"eth_chainId"});
  if (cid === VIC_CHAIN_ID_HEX) return;
  try{
    await eth.request({method:"wallet_switchEthereumChain", params:[{chainId:VIC_CHAIN_ID_HEX}]});
  }catch(err){
    if (err.code===4902){
      await eth.request({
        method:"wallet_addEthereumChain",
        params:[{
          chainId: VIC_CHAIN_ID_HEX,
          chainName:"Viction Mainnet",
          nativeCurrency:{name:"VIC",symbol:"VIC",decimals:18},
          rpcUrls:[RPC_URL],
          blockExplorerUrls:[EXPLORER]
        }]
      });
    }else{ throw err; }
  }
}

// ===== Kết nối ví =====
async function connectWallet(){
  try{
    await ensureViction();
    provider = new ethers.providers.Web3Provider(window.ethereum,"any");
    await provider.send("eth_requestAccounts",[]);
    signer = provider.getSigner();
    account = await signer.getAddress();
    if ($("#walletAddress")) $("#walletAddress").textContent = account;
    if ($("#walletChip")) $("#walletChip").textContent = shortAddr(account);
    toast("Kết nối ví thành công: " + shortAddr(account));
    await refreshBalances();
  }catch(err){
    console.error(err);
    toast("Lỗi kết nối ví: "+(err.message||err));
  }
}

// ========================== ĐOẠN 2 ==========================
// Lấy ABI đã nạp & tạo instance contract
async function ensureABIs(){
  let t0 = Date.now();
  while((!MUABAN_ABI || !VIN_ABI) && Date.now()-t0 < 8000){
    await new Promise(r=>setTimeout(r,100));
  }
  if (!MUABAN_ABI || !VIN_ABI){
    throw new Error("Không tải được ABI. Hãy chắc file Muaban_ABI.json và VinToken_ABI.json nằm cùng thư mục.");
  }
}

function getMuabanWithSigner(signer){ return new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, signer); }
function getVinWithSigner(signer){ return new ethers.Contract(VIN_ADDR, VIN_ABI, signer); }
function getMuaban(providerOrSigner){ return new ethers.Contract(MUABAN_ADDR, MUABAN_ABI, providerOrSigner); }
function getVin(providerOrSigner){ return new ethers.Contract(VIN_ADDR, VIN_ABI, providerOrSigner); }

// Làm mới số dư ví & VIN/VIC
async function refreshBalances(){
  try{
    if (!provider || !account) return;
    await ensureABIs();

    const vicBal = await provider.getBalance(account);
    const vicText = parseFloat(ethers.utils.formatEther(vicBal)).toFixed(4);
    if ($("#vicBalance")) $("#vicBalance").textContent = `VIC: ${vicText}`;

    const vin = getVin(provider);
    const vinBal = await vin.balanceOf(account);
    // Hiển thị 4 số thập phân cho VIN
    const vinText = ethers.utils.formatUnits(vinBal, 18);
    const [intPart, decPart=""] = vinText.split(".");
    if ($("#vinBalance")) $("#vinBalance").textContent = `VIN: ${intPart}.${(decPart+"0000").slice(0,4)}`;
  }catch(err){
    console.warn("refreshBalances error:", err);
  }
}

// Kiểm tra đã đăng ký chưa (nếu contract public mapping 'registered')
async function isRegistered(addr){
  try{
    await ensureABIs();
    const mb = getMuaban(provider || new ethers.providers.JsonRpcProvider(RPC_URL));
    if (mb.registered){ return await mb.registered(addr); }
    return false;
  }catch{
    return false;
  }
}

// Đăng ký tài khoản
async function doRegister(){
  try{
    if (!provider) await connectWallet();
    await ensureABIs();
    const s = signer || (provider && provider.getSigner());
    const acc = account || (s && await s.getAddress());
    if (!s || !acc) throw new Error("Chưa kết nối ví.");

    if (await isRegistered(acc)){ toast("Bạn đã đăng ký rồi."); return; }

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const data  = iface.encodeFunctionData("register",[]);
    const sim   = await simulateAndDecode({provider, to: MUABAN_ADDR, from: acc, data});
    if (!sim.ok){ return alert("Giao dịch đăng ký bị từ chối: " + (sim.reason || "Không rõ (Mobile)")); }

    const gasPrice = await provider.getGasPrice();
    const tx = await s.sendTransaction({
      to: MUABAN_ADDR,
      from: acc,
      data,
      value: "0x0",
      gasPrice,
      gasLimit: ethers.BigNumber.from("120000")
    });
    toast("Đang đăng ký…");
    await tx.wait();
    toast("Đăng ký thành công!");
  }catch(err){
    const raw = err?.data?.data || err?.data || err?.error?.data || err?.reason || err?.message;
    const decoded = typeof raw === "string" ? decodeRevertReason(raw) : "";
    alert("send.register\n" + (decoded || raw || err));
    console.error("doRegister error:", err);
  }
}

// ===== Tạo sản phẩm (simulate + decode reason) =====
async function submitCreate(e){
  e?.preventDefault();
  try{
    await ensureViction();
    await ensureABIs();

    const name  = ($("#createName").value||"").trim();
    const ipfs  = ($("#createIPFS").value||"").trim();
    const unit  = ($("#createUnit").value||"").trim();
    const priceRaw = cleanIntString($("#createPrice").value);
    const priceVND = ethers.BigNumber.from(priceRaw || "0");
    const wallet = ($("#createWallet").value||"").trim();
    const days   = Number($("#createDays").value||0);

    if (!name || name.length>500){ return alert("Tên phải có và ≤ 500 ký tự."); }
    if (!ipfs){ return alert("Vui lòng nhập IPFS hình/video (ipfs://… hoặc https link)."); }
    if (!unit){ return alert("Vui lòng nhập đơn vị (vd: chiếc, cái…)."); }
    if (priceVND.lte(0)){ return alert("Giá VNĐ phải là số nguyên dương (vd 1200000)."); }
    if (!ethers.utils.isAddress(wallet)){ return alert("Ví nhận tiền không hợp lệ (0x…)."); }
    if (!Number.isFinite(days) || days<=0){ return alert("Số ngày giao hàng phải > 0."); }

    if (!provider){
      provider = new ethers.providers.Web3Provider(window.ethereum,"any");
      await provider.send("eth_requestAccounts",[]);
    }
    signer  = provider.getSigner();
    account = await signer.getAddress();

    if (!(await isRegistered(account))){
      return alert("Bạn chưa đăng ký tài khoản. Vui lòng bấm nút 'Đăng ký' trước khi đăng sản phẩm.");
    }

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const descriptionCID = `unit:${unit}`;
    const imageCID = ipfs;
    const data = iface.encodeFunctionData("createProduct", [
      name, descriptionCID, imageCID, priceVND, days, wallet, true
    ]);

    const sim = await simulateAndDecode({ provider, to: MUABAN_ADDR, from: account, data });
    if (!sim.ok){
      const msg = (sim.reason||"").toUpperCase();
      if (msg.includes("NOT_REGISTERED"))     return alert("Bạn chưa đăng ký tài khoản. Bấm 'Đăng ký' trước.");
      if (msg.includes("PRICE_REQUIRED"))     return alert("Giá VNĐ phải là số nguyên dương.");
      if (msg.includes("DELIVERY_REQUIRED"))  return alert("Số ngày giao hàng phải > 0.");
      if (msg.includes("PAYOUT_WALLET_ZERO")) return alert("Ví nhận tiền không hợp lệ.");
      return alert("Giao dịch sẽ bị từ chối bởi hợp đồng:\n" + (sim.reason || "Không rõ (Mobile)"));
    }

    const gasPrice = await provider.getGasPrice();
    const tx = await signer.sendTransaction({
      to: MUABAN_ADDR,
      from: account,
      data,
      value: "0x0",
      gasPrice,
      gasLimit: ethers.BigNumber.from("300000")
    });

    toast("Đang gửi giao dịch…");
    await tx.wait();
    toast("Đăng sản phẩm thành công!");
    closeCreateModal?.();
    await reloadProducts?.();
  }catch(err){
    const raw = err?.data?.data || err?.data || err?.error?.data || err?.reason || err?.message;
    const decoded = typeof raw === "string" ? decodeRevertReason(raw) : "";
    alert(`send.createProduct\n${decoded || raw || err}`);
    console.error("submitCreate error:", err);
  }
}

// ========================== ĐOẠN 3 ==========================

// ===== Tải danh sách sản phẩm =====
async function reloadProducts(){
  try{
    await ensureABIs();
    const mb = getMuaban(provider || new ethers.providers.JsonRpcProvider(RPC_URL));
    const total = await mb.productCount();
    const list = $("#productList");
    if (!list) return;
    list.innerHTML = "";

    for (let i=1; i<=total; i++){
      const p = await mb.products(i);
      if (!p.active) continue;

      // parse unit từ descriptionCID
      let unit = "";
      try{
        const desc = (p.descriptionCID||"").toString();
        if (desc.startsWith("unit:")) unit = desc.slice(5);
      }catch(_){}

      const price = ethers.BigNumber.from(p.priceVND).toString();
      const div = document.createElement("div");
      div.className = "product";
      div.innerHTML = `
        <h3>${p.name}</h3>
        <p>Đơn vị: ${unit}</p>
        <p>Giá (VNĐ): ${price}</p>
        <p>Ngày giao hàng: ${p.deliveryDaysMax}</p>
        <button data-pid="${i}" data-price="${price}" class="btn-buy">Mua</button>
      `;
      list.appendChild(div);
    }

    // gắn click cho nút mua
    list.querySelectorAll(".btn-buy").forEach(btn=>{
      btn.addEventListener("click", async (ev)=>{
        const pid = Number(ev.currentTarget.dataset.pid);
        const priceVND = ev.currentTarget.dataset.price;
        await buyProduct(pid, priceVND);
      });
    });

  }catch(err){
    console.error("reloadProducts error:", err);
  }
}

// ===== Mua sản phẩm =====
async function buyProduct(pid, priceVND){
  try{
    if (!provider) await connectWallet();
    await ensureABIs();

    const vin = getVinWithSigner(signer);
    const ifaceVin = new ethers.utils.Interface(VIN_ABI);

    // approve nếu thiếu allowance
    const allow = await vin.allowance(account, MUABAN_ADDR);
    if (allow.lt(priceVND)){
      const dataApprove = ifaceVin.encodeFunctionData("approve", [MUABAN_ADDR, priceVND]);
      const simA = await simulateAndDecode({provider, to: VIN_ADDR, from: account, data: dataApprove});
      if (!simA.ok){ return alert("Approve VIN bị từ chối: " + (simA.reason||"")); }

      const tx1 = await signer.sendTransaction({
        to: VIN_ADDR,
        from: account,
        data: dataApprove,
        gasLimit: ethers.BigNumber.from("120000"),
        gasPrice: await provider.getGasPrice()
      });
      toast("Đang gửi approve VIN…");
      await tx1.wait();
    }

    const iface = new ethers.utils.Interface(MUABAN_ABI);
    const data  = iface.encodeFunctionData("placeOrder", [pid]);
    const sim   = await simulateAndDecode({provider, to: MUABAN_ADDR, from: account, data});
    if (!sim.ok){ return alert("Không thể mua sản phẩm này: " + (sim.reason||"")); }

    const tx2 = await signer.sendTransaction({
      to: MUABAN_ADDR,
      from: account,
      data,
      gasPrice: await provider.getGasPrice(),
      gasLimit: ethers.BigNumber.from("250000")
    });
    toast("Đang mua sản phẩm…");
    await tx2.wait();
    toast("Mua hàng thành công!");
    await reloadProducts();
  }catch(err){
    console.error("buyProduct error:", err);
    alert("buyProduct error: " + (err?.message||err));
  }
}

// ===== Gắn event cho các nút =====
window.addEventListener("DOMContentLoaded", ()=>{
  $("#btnConnect")?.addEventListener("click", connectWallet);
  $("#btnRegister")?.addEventListener("click", doRegister);
  $("#btnCreate")?.addEventListener("click", submitCreate);
  $("#btnReload")?.addEventListener("click", reloadProducts);

  // load sản phẩm ban đầu
  reloadProducts();
});

// ========================== ĐOẠN 4 ==========================

// ===== Đóng modal tạo sản phẩm =====
function closeCreateModal(){
  try{
    $("#createName") && ($("#createName").value = "");
    $("#createIPFS") && ($("#createIPFS").value = "");
    $("#createUnit") && ($("#createUnit").value = "");
    $("#createPrice") && ($("#createPrice").value = "");
    $("#createWallet") && ($("#createWallet").value = "");
    $("#createDays") && ($("#createDays").value = "");
    const modal = document.querySelector("#createModal");
    if (modal) modal.style.display = "none";
  }catch(e){}
}

// ===== Tải lại số dư định kỳ =====
setInterval(()=>{
  if (account && provider){
    refreshBalances();
  }
}, 15000);

// ===== Khởi động khi load trang =====
(async ()=>{
  try{
    if (window.ethereum){
      provider = new ethers.providers.Web3Provider(window.ethereum,"any");
      const accs = await provider.listAccounts();
      if (accs.length>0){
        signer = provider.getSigner();
        account = accs[0];
        $("#walletAddress") && ($("#walletAddress").textContent = account);
        $("#walletChip") && ($("#walletChip").textContent = shortAddr(account));
        await refreshBalances();
      }
    }
    await reloadProducts();
  }catch(err){
    console.warn("init error:", err);
  }
})();

// ========================== HẾT FILE app.js ==========================
