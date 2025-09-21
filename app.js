/* app.js — Muaban.vin (ethers v6)
   - Network: Viction Mainnet (chainId 88)
   - Explorer: https://vicscan.xyz
   - Contract addresses are taken from window.MB_CONFIG in index.html
   - Robust allowance flow: auto-approve before payRegistration / placeOrder
   - VIN/VND = (VIC/USDT from Binance × 100) × (USDT/VND from CoinGecko)
   - vinPerVND (wei per 1 VND) = floor(1e18 / (VND per 1 VIN))
*/

(() => {
  // ----------------------- DOM helpers -----------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function toast(msg, ms = 2800) {
    const t = $("#toast");
    if (!t) return alert(msg);
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("show"), ms);
  }

  function shortAddr(addr) {
    if (!addr) return "";
    return addr.slice(0, 6) + "…" + addr.slice(-4);
  }

  const fmt = {
    int(n) { try { return Number(n).toLocaleString("vi-VN"); } catch { return String(n); } },
    vnd(n) { try { return Number(n).toLocaleString("vi-VN"); } catch { return String(n); } },
    vinWeiToVIN(wei) {
      try { return Number(ethers.formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 6 }); }
      catch { return String(wei); }
    }
  };

  // ----------------------- Global state -----------------------
  const C = window.MB_CONFIG || {};
  const VIC_CHAIN_ID_HEX = C?.VIC?.CHAIN_ID_HEX || "0x58";
  const VIC_EXPLORER = C?.VIC?.EXPLORER || "https://vicscan.xyz";
  const SCAN_LIMIT = 500; // số lượng PID tối đa quét để hiển thị lên trang chủ (có thể tăng)
  const PAGE_SIZE = C?.PAGE_SIZE || 20;

  let provider = null;
  let signer = null;
  let account = null;

  let muaban = null;
  let vin = null;
  let abiMuaban = null;
  let abiVin = null;

  // Giá:
  // - priceVIN_VND: số VND cho 1 VIN (float)
  // - vinPerVND:   số VIN-wei ứng với 1 VND (BigInt, floor)
  let priceVIN_VND = null;
  let vinPerVND = null;

  // cache product
  const productCache = new Map(); // pid -> Product

  // ----------------------- Network helpers -----------------------
  async function ensureVictionAfterUnlock() {
    const eth = window.ethereum;
    if (!eth) throw new Error("Không tìm thấy MetaMask (window.ethereum).");

    const chainId = await eth.request({ method: "eth_chainId" });
    if (chainId === VIC_CHAIN_ID_HEX) return;

    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: VIC_CHAIN_ID_HEX }]
      });
    } catch (err) {
      // 4902 = chain not added
      if (err && err.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: VIC_CHAIN_ID_HEX,
            chainName: C?.VIC?.CHAIN_NAME || "Viction Mainnet",
            nativeCurrency: C?.VIC?.NATIVE_CURRENCY || { name: "VIC", symbol: "VIC", decimals: 18 },
            rpcUrls: C?.VIC?.RPC_URLS || ["https://rpc.viction.xyz"],
            blockExplorerUrls: [VIC_EXPLORER]
          }]
        });
      } else {
        throw err;
      }
    }
  }

  // ----------------------- Ethers init -----------------------
  async function initEthers() {
    if (!window.ethereum) throw new Error("Vui lòng cài MetaMask.");
    await ensureVictionAfterUnlock();

    provider = new ethers.BrowserProvider(window.ethereum);
    const chain = await provider.getNetwork();
    if (Number(chain.chainId) !== 88) {
      throw new Error("Sai mạng. Hãy chuyển sang Viction (chainId 88).");
    }

    signer = await provider.getSigner();
    account = await signer.getAddress();

    // load ABIs
    if (!abiMuaban) {
      const r = await fetch("Muaban_ABI.json", { cache: "no-store" });
      abiMuaban = await r.json();
    }
    if (!abiVin) {
      const r = await fetch("VinToken_ABI.json", { cache: "no-store" });
      abiVin = await r.json();
    }

    muaban = new ethers.Contract(C.MUABAN_ADDRESS, abiMuaban, signer);
    vin    = new ethers.Contract(C.VIN_TOKEN, abiVin, signer);
  }

  // ----------------------- Pricing -----------------------
  async function fetchPricing() {
    try {
      // 1) VIC/USDT (Binance)
      const res1 = await fetch(C.BINANCE_VIC_USDT, { cache: "no-store" });
      const j1 = await res1.json();
      const vicUsdt = Number(j1?.price || 0);

      // 2) USDT/VND (CoinGecko)
      const res2 = await fetch(C.COINGECKO_USDT_VND, { cache: "no-store" });
      const j2 = await res2.json();
      const usdtVnd = Number(j2?.tether?.vnd || j2?.usd?.vnd || 0);

      if (!vicUsdt || !usdtVnd) throw new Error("Không lấy được giá.");

      // 3) VIN/VND = VIC/USDT × 100 × USDT/VND
      const vinVnd = vicUsdt * 100 * usdtVnd;
      priceVIN_VND = vinVnd;

      // 4) vinPerVND (wei/VND) = floor( 1e18 / vinVnd )
      //    Dùng BigInt để an toàn số lớn
      const ONE_ETHER = 10n ** 18n;
      const denom = BigInt(Math.floor(vinVnd)); // VND cho 1 VIN (làm tròn xuống)
      if (denom > 0n) {
        vinPerVND = ONE_ETHER / denom; // floor
        if (vinPerVND <= 0n) vinPerVND = 1n; // tối thiểu 1 wei/VND
      } else {
        vinPerVND = null;
      }

      // update UI
      $("#vin-vnd-value").textContent = fmt.vnd(vinVnd);
    } catch (e) {
      console.warn("fetchPricing error:", e);
      $("#vin-vnd-value").textContent = "—";
      vinPerVND = null;
    }
  }

  function startPriceTicker() {
    fetchPricing();
    // refresh mỗi 45s để nhẹ
    setInterval(fetchPricing, 45000);
  }

  // ----------------------- Wallet / Balances -----------------------
  async function connectWallet() {
    try {
      await ensureVictionAfterUnlock();
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await initEthers();
      await refreshWalletUI();
      toast("Đã kết nối ví.");
    } catch (e) {
      console.error("connectWallet error:", e);
      toast("Kết nối ví thất bại.");
    }
  }

  async function refreshWalletUI() {
    if (!provider || !signer) return;

    const addr = account || await signer.getAddress();
    const vicBalWei = await provider.getBalance(addr);
    const vinBalWei = await vin.balanceOf(addr);

    $("#balVIC").textContent = Number(ethers.formatUnits(vicBalWei, 18)).toFixed(4);
    $("#balVIN").textContent = Number(ethers.formatUnits(vinBalWei, 18)).toFixed(4);
    $("#addrShort").textContent = shortAddr(addr);
    $("#addrShort").href = `${VIC_EXPLORER}/address/${addr}`;

    $("#btnConnect").classList.add("hidden");
    $("#walletInfo").classList.remove("hidden");

    // Set footer links
    $("#lnkContract").href = `${VIC_EXPLORER}/address/${C.MUABAN_ADDRESS}`;
    $("#lnkVIN").href = `${VIC_EXPLORER}/address/${C.VIN_TOKEN}`;

    // kiểm tra đăng ký
    updateRegisterButton();
  }

  async function updateRegisterButton() {
    try {
      if (!muaban || !account) return;
      const registered = await muaban.registered(account);
      const btn = $("#btnRegister");
      if (registered) btn.classList.add("hidden");
      else btn.classList.remove("hidden");
    } catch (e) {
      console.warn("updateRegisterButton:", e);
    }
  }

  // ----------------------- Allowance helpers -----------------------
  async function ensureAllowance(spender, requiredWei) {
    const current = await vin.allowance(account, spender);
    if (current >= requiredWei) return;

    // Approve thêm (set exact required or MaxUint256 — ở đây set exact để minh bạch)
    toast("Đang approve VIN…");
    const tx = await vin.approve(spender, requiredWei);
    await tx.wait();
    toast("Approve xong.");
  }

  // ----------------------- Registration -----------------------
  async function doRegister() {
    try {
      if (!muaban) await initEthers();

      // REG_FEE = 0.001 VIN (18 decimals) => 1e15 wei
      const REG_FEE = 10n ** 15n;

      await ensureAllowance(C.MUABAN_ADDRESS, REG_FEE);

      toast("Đang đăng ký (payRegistration)...");
      const tx = await muaban.payRegistration();
      await tx.wait();

      toast("Đăng ký thành công.");
      await updateRegisterButton();
      await refreshWalletUI();
    } catch (e) {
      console.error("doRegister error:", e);
      toast("Đăng ký thất bại. Xem console (F12) để biết chi tiết.");
    }
  }

  // ----------------------- Products (create / update / list) -----------------------
  function parseUnitFromDescCID(desc) {
    // UI lưu "unit:<...>", ví dụ "unit:cái"
    if (!desc || typeof desc !== "string") return "";
    const p = desc.trim();
    if (p.startsWith("unit:")) return p.slice(5).trim();
    return "";
  }

  function buildDescCIDFromUnit(unit) {
    return `unit:${(unit || "").trim()}`;
  }

  async function submitCreate() {
    try {
      if (!muaban) await initEthers();

      const name = ($("#createName").value || "").trim();
      const ipfs = ($("#createIPFS").value || "").trim();
      const unit = ($("#createUnit").value || "").trim();
      const priceVND = BigInt(Math.max(1, Number($("#createPrice").value || 0)));
      const wallet = ($("#createWallet").value || "").trim();
      const days = Number($("#createDays").value || 0);
      const active = $("#createActive").checked;

      if (!name || !ipfs || !unit || !priceVND || !wallet || !days) {
        toast("Vui lòng nhập đủ thông tin.");
        return;
      }

      const descriptionCID = buildDescCIDFromUnit(unit);
      const imageCID = ipfs;

      toast("Đang tạo sản phẩm...");
      const tx = await muaban.createProduct(
        name,
        descriptionCID,
        imageCID,
        priceVND,               // uint256
        days,                   // uint32
        wallet,                 // address payout
        active                  // bool
      );
      await tx.wait();

      toast("Đăng sản phẩm thành công.");
      // clear form
      $("#createName").value = "";
      $("#createIPFS").value = "";
      $("#createUnit").value = "";
      $("#createPrice").value = "";
      $("#createWallet").value = "";
      $("#createDays").value = "";
      $("#createActive").checked = true;

      // reload list
      await loadHomeProducts();
    } catch (e) {
      console.error("submitCreate error:", e);
      toast("Đăng sản phẩm thất bại. Kiểm tra console (F12).");
    }
  }

  async function openUpdateModal(pid, product) {
    $("#updPid").value = String(pid);
    $("#updPrice").value = product?.priceVND || "";
    $("#updWallet").value = product?.payoutWallet || "";
    $("#updDays").value = product?.deliveryDaysMax || "";
    $("#updActive").checked = !!product?.active;
    $("#modalUpdate").classList.remove("hidden");
  }

  async function doUpdateProduct() {
    try {
      const pid = Number($("#updPid").value);
      const priceVND = BigInt(Math.max(1, Number($("#updPrice").value || 0)));
      const payout = ($("#updWallet").value || "").trim();
      const days = Number($("#updDays").value || 0);
      const active = $("#updActive").checked;

      if (!pid || !priceVND || !payout || !days) {
        toast("Thiếu dữ liệu cập nhật.");
        return;
      }

      toast("Đang cập nhật sản phẩm…");
      const tx = await muaban.updateProduct(pid, priceVND, days, payout, active);
      await tx.wait();
      toast("Cập nhật xong.");

      $("#modalUpdate").classList.add("hidden");
      await loadHomeProducts();
    } catch (e) {
      console.error("doUpdateProduct:", e);
      toast("Cập nhật thất bại.");
    }
  }

  // Quét danh sách sản phẩm bằng cách gọi getProduct(pid) tuần tự (hợp đồng không có hàm đếm tổng).
  async function scanProducts(maxScan = SCAN_LIMIT) {
    if (!muaban) await initEthers();

    $("#homeLoading").classList.remove("hidden");
    $("#homeEmpty").classList.add("hidden");

    const found = [];
    for (let pid = 1; pid <= maxScan; pid++) {
      try {
        const p = await muaban.getProduct(pid);
        if (p && p.seller && p.seller !== ethers.ZeroAddress) {
          // chuẩn hóa object
          const obj = {
            productId: Number(p.productId),
            seller: p.seller,
            name: p.name,
            descriptionCID: p.descriptionCID,
            imageCID: p.imageCID,
            priceVND: Number(p.priceVND),
            deliveryDaysMax: Number(p.deliveryDaysMax),
            payoutWallet: p.payoutWallet,
            active: Boolean(p.active),
            createdAt: Number(p.createdAt || 0),
            updatedAt: Number(p.updatedAt || 0)
          };
          productCache.set(obj.productId, obj);
          found.push(obj);
        }
      } catch (e) {
        // ignore holes
      }
    }
    $("#homeLoading").classList.add("hidden");
    if (!found.length) $("#homeEmpty").classList.remove("hidden");
    return found;
  }

  function renderProducts(list) {
    const grid = $("#productsList");
    grid.innerHTML = "";
    const me = (account || "").toLowerCase();

    list.forEach(p => {
      const tpl = $("#tplProductCard");
      const node = tpl.content.firstElementChild.cloneNode(true);

      node.querySelector("[data-bind='imageCID']").src = p.imageCID || "";
      node.querySelector("[data-bind='name']").textContent = p.name || "—";
      node.querySelector("[data-bind='priceVND']").textContent = fmt.vnd(p.priceVND || 0);
      node.querySelector("[data-bind='unit']").textContent = parseUnitFromDescCID(p.descriptionCID) || "đơn vị";
      node.querySelector("[data-bind='activeText']").textContent = p.active ? "Còn hàng" : "Hết hàng";

      const btnBuy = node.querySelector("[data-action='buy']");
      const btnUpd = node.querySelector("[data-action='update']");

      // Quy tắc hiển thị nút
      if (!p.active) {
        btnBuy.classList.add("hidden");
      }
      if (me && me === p.seller.toLowerCase()) {
        btnUpd.classList.remove("hidden");
      }

      // Actions
      btnBuy.addEventListener("click", () => openBuyModal(p.productId));
      btnUpd.addEventListener("click", () => openUpdateModal(p.productId, p));

      grid.appendChild(node);
    });
  }

  async function loadHomeProducts() {
    const q = ($("#searchInput").value || "").trim().toLowerCase();
    let all = await scanProducts(SCAN_LIMIT);
    if (q) {
      all = all.filter(p => (p.name || "").toLowerCase().includes(q));
    }
    // phân trang đơn giản (nếu cần)
    renderProducts(all.slice(0, PAGE_SIZE));
  }

  // ----------------------- BUY modal & Place order -----------------------
  function encodeBuyerInfo(obj) {
    // tạm thời dùng base64 JSON như "cipher"
    const s = JSON.stringify(obj || {});
    return btoa(unescape(encodeURIComponent(s)));
  }

  function decodeBuyerInfo(b64) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch {
      return null;
    }
  }

  async function openBuyModal(pid) {
    try {
      const p = productCache.get(pid) || await muaban.getProduct(pid);
      if (!p || !p.seller || p.seller === ethers.ZeroAddress) {
        toast("Sản phẩm không tồn tại.");
        return;
      }
      const obj = productCache.get(pid) || {
        productId: Number(p.productId),
        seller: p.seller,
        name: p.name,
        descriptionCID: p.descriptionCID,
        imageCID: p.imageCID,
        priceVND: Number(p.priceVND),
        deliveryDaysMax: Number(p.deliveryDaysMax),
        payoutWallet: p.payoutWallet,
        active: Boolean(p.active),
      };

      $("#buyImg").src = obj.imageCID || "";
      $("#buyName").textContent = obj.name || "—";
      $("#buyPriceVND").textContent = fmt.vnd(obj.priceVND || 0);
      $("#buyUnit").textContent = parseUnitFromDescCID(obj.descriptionCID) || "đơn vị";
      $("#buyPayout").textContent = shortAddr(obj.payoutWallet);
      $("#buyPayout").href = `${VIC_EXPLORER}/address/${obj.payoutWallet}`;
      $("#buyDays").textContent = String(obj.deliveryDaysMax || 0);
      $("#buyQty").value = 1;
      $("#buyTotalVIN").textContent = "—";

      // Tính tổng VIN ước tính
      const recalc = () => {
        const qty = Math.max(1, Number($("#buyQty").value || 1));
        const totalVND = (obj.priceVND || 0) * qty;
        if (priceVIN_VND) {
          const totalVIN = totalVND / priceVIN_VND; // float hiển thị
          $("#buyTotalVIN").textContent = totalVIN.toFixed(6);
        }
      };
      $("#buyQty").oninput = recalc;
      recalc();

      $("#modalBuy").classList.remove("hidden");

      // Bind nút xác nhận
      $("#btnPlaceOrder").onclick = async () => {
        try {
          if (!vinPerVND || vinPerVND <= 0n) {
            toast("Chưa có tỷ giá VIN/VND. Thử lại sau.");
            return;
          }
          const fullname = ($("#buyFullname").value || "").trim();
          const phone = ($("#buyPhone").value || "").trim();
          const address = ($("#buyAddress").value || "").trim();
          const note = ($("#buyNote").value || "").trim();
          const qty = Math.max(1, Number($("#buyQty").value || 1));
          if (!fullname || !phone || !address) {
            toast("Vui lòng nhập đủ Họ tên / SĐT / Địa chỉ.");
            return;
          }

          // Tính vinAmount ước tính để duyệt allowance
          const totalVND = BigInt((obj.priceVND || 0) * qty);
          // vinAmount = ceil(totalVND * vinPerVND / 1) do hợp đồng _ceilDiv(totalVND * vinPerVND, 1)
          // => thực chất = totalVND * vinPerVND
          const vinAmount = totalVND * vinPerVND;

          // Approve đủ tiền
          await ensureAllowance(C.MUABAN_ADDRESS, vinAmount);

          // Mã hóa buyer info
          const cipher = encodeBuyerInfo({ fullname, phone, address, note });

          toast("Đang gửi đơn hàng (placeOrder)...");
          const tx = await muaban.placeOrder(
            obj.productId,
            qty,
            vinPerVND,  // uint256 VIN-wei per 1 VND
            cipher
          );
          await tx.wait();

          toast("Đặt hàng thành công.");
          $("#modalBuy").classList.add("hidden");
        } catch (e) {
          console.error("placeOrder error:", e);
          toast("Đặt hàng thất bại. Kiểm tra console (F12).");
        }
      };
    } catch (e) {
      console.error("openBuyModal:", e);
      toast("Không mở được cửa sổ mua.");
    }
  }

  // ----------------------- Buyer actions -----------------------
  async function loadBuyerOrders() {
    // (Hợp đồng chưa có liệt kê theo ví, cần backend hoặc sự kiện để index.
    // Ở bản này: placeholder hiển thị thông báo.)
    $("#buyerOrders").innerHTML = "";
    $("#buyerEmpty").classList.remove("hidden");
  }

  // ----------------------- Seller orders/products -----------------------
  async function loadSellerStuff() {
    try {
      $("#sellerProducts").innerHTML = "";
      const arr = await muaban.getSellerProductIds(account);
      if (!arr || !arr.length) {
        $("#sellerEmpty").classList.remove("hidden");
      } else {
        $("#sellerEmpty").classList.add("hidden");
        for (const pid of arr) {
          const p = await muaban.getProduct(Number(pid));
          const obj = {
            productId: Number(p.productId),
            name: p.name,
            priceVND: Number(p.priceVND),
            active: Boolean(p.active),
            deliveryDaysMax: Number(p.deliveryDaysMax)
          };
          const row = document.createElement("div");
          row.className = "row order";
          row.innerHTML = `
            <div class="col">
              <div>PID: <b>#${obj.productId}</b> — ${obj.name}</div>
              <div>Giá: <b>${fmt.vnd(obj.priceVND)}</b> VND • Max giao: ${obj.deliveryDaysMax} ngày • Trạng thái: ${obj.active ? "Đang bán" : "Tắt"}</div>
            </div>
            <div class="col actions">
              <button class="btn outline" data-pid="${obj.productId}">Cập nhật</button>
            </div>
          `;
          row.querySelector("button").onclick = () => openUpdateModal(obj.productId, p);
          $("#sellerProducts").appendChild(row);
        }
      }

      // Đơn hàng seller (placeholder, vì hợp đồng không có index theo seller)
      $("#sellerOrders").innerHTML = "";
      $("#sellerOrdersEmpty").classList.remove("hidden");
    } catch (e) {
      console.error("loadSellerStuff:", e);
      $("#sellerEmpty").classList.remove("hidden");
      $("#sellerOrdersEmpty").classList.remove("hidden");
    }
  }

  // ----------------------- Navigation -----------------------
  function showScreen(id) {
    $$(".screen").forEach(s => s.classList.add("hidden"));
    $(id).classList.remove("hidden");
    $$(".subnav .tab").forEach(b => b.classList.remove("active"));
    if (id === "#screenHome") $("#navHome").classList.add("active");
    if (id === "#screenCreate") $("#navCreate").classList.add("active");
    if (id === "#screenBuyer") $("#navBuyer").classList.add("active");
    if (id === "#screenSeller") $("#navSeller").classList.add("active");
  }

  // ----------------------- Event bindings -----------------------
  function bindEvents() {
    $("#btnConnect").addEventListener("click", connectWallet);
    $("#btnRegister").addEventListener("click", doRegister);

    $("#btnSearch").addEventListener("click", loadHomeProducts);
    $("#searchInput").addEventListener("keypress", e => { if (e.key === "Enter") loadHomeProducts(); });

    $("#navHome").addEventListener("click", async () => { showScreen("#screenHome"); await loadHomeProducts(); });
    $("#navCreate").addEventListener("click", async () => { showScreen("#screenCreate"); });
    $("#navBuyer").addEventListener("click", async () => { showScreen("#screenBuyer"); await loadBuyerOrders(); });
    $("#navSeller").addEventListener("click", async () => { showScreen("#screenSeller"); await loadSellerStuff(); });

    $("#btnCreate").addEventListener("click", submitCreate);

    // Modals
    $("#buyClose").addEventListener("click", () => $("#modalBuy").classList.add("hidden"));
    $("#btnBuyCancel").addEventListener("click", () => $("#modalBuy").classList.add("hidden"));

    $("#updClose").addEventListener("click", () => $("#modalUpdate").classList.add("hidden"));
    $("#btnUpdCancel").addEventListener("click", () => $("#modalUpdate").classList.add("hidden"));
    $("#btnDoUpdate").addEventListener("click", doUpdateProduct);

    // Wallet events
    if (window.ethereum) {
      window.ethereum.on("accountsChanged", () => location.reload());
      window.ethereum.on("chainChanged", () => location.reload());
    }
  }

  // ----------------------- Init -----------------------
  async function init() {
    bindEvents();
    startPriceTicker();
    // Tự tải danh sách trang chủ (chế độ xem công khai)
    await loadHomeProducts();
  }

  // Boot
  document.addEventListener("DOMContentLoaded", init);
})();
