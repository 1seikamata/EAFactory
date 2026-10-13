import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import {
  verifyLicense,
  createNewLicense,
  loadLicenses,
  notifyMailService,
} from "./server/licenseStore";

dotenv.config();

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "5mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // ==========================================
  // ライセンス認証コード管理 API
  // ==========================================

  // 1. メールアドレス ＋ 認証コード の照合
  app.post("/api/license/verify", (req, res) => {
    try {
      const { email, code, deviceId } = req.body;
      const result = verifyLicense(email, code, deviceId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error });
      }
      return res.json({ success: true, license: result.license });
    } catch (err: any) {
      console.error("License verification error:", err);
      return res.status(500).json({ success: false, error: "認証処理中にサーバーエラーが発生しました。" });
    }
  });

  // 2. 現在のライセンス状態確認
  app.post("/api/license/status", (req, res) => {
    try {
      const { email, code, deviceId } = req.body;
      const result = verifyLicense(email, code, deviceId);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: "ステータス確認中にエラーが発生しました。" });
    }
  });

  // 3. テスト用デモ認証コード一覧の取得
  app.get("/api/license/demo-codes", (_req, res) => {
    const licenses = loadLicenses();
    // 最初の2件（初期シードなど）をデモ用として返却
    const demoList = licenses.slice(0, 3).map((l) => ({
      email: l.email,
      code: l.code,
      type: l.type,
      notes: l.notes,
      expiresAt: l.expiresAt,
    }));
    return res.json({ success: true, demoCodes: demoList });
  });

  // 4. 新規ライセンスの発行（管理ツールまたは手動テスト用）
  app.post("/api/license/generate", async (req, res) => {
    try {
      const { email, type, days, notes } = req.body;
      if (!email || !type) {
        return res.status(400).json({ success: false, error: "email and type are required." });
      }
      const newLicense = createNewLicense({ email, type, days, notes });

      // ユーザーのメール送信サービスへ通知
      await notifyMailService({
        email: newLicense.email,
        code: newLicense.code,
        type: newLicense.type,
        expiresAt: newLicense.expiresAt,
      });

      return res.json({ success: true, license: newLicense });
    } catch (err: any) {
      console.error("License generation error:", err);
      return res.status(500).json({ success: false, error: "ライセンス発行に失敗しました。" });
    }
  });

  // 5. Stripe Webhookエンドポイント（本番決済完了時の自動発行＆メール送信用）
  app.post("/api/stripe/webhook", async (req, res) => {
    try {
      const event = req.body;
      console.log(`[Stripe Webhook] Received event: ${event?.type}`);

      // checkout.session.completed 決済成功時
      if (event?.type === "checkout.session.completed") {
        const session = event.data?.object;
        const customerEmail =
          session?.customer_details?.email ||
          session?.customer_email ||
          "buyer@example.com";
        const planType =
          session?.metadata?.planType === "subscription"
            ? "subscription"
            : "lifetime";

        const license = createNewLicense({
          email: customerEmail,
          type: planType,
          notes: `Stripe決済完了 (${session?.id || 'manual'})`,
        });

        // 作成済みメール送信サービスへ認証コードを送信
        await notifyMailService({
          email: customerEmail,
          code: license.code,
          type: license.type,
          expiresAt: license.expiresAt,
        });

        console.log(`[Stripe Webhook] License created & mail triggered for: ${customerEmail}`);
      }

      return res.json({ received: true });
    } catch (err: any) {
      console.error("Stripe Webhook error:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // 6. Stripe Checkout Session作成エンドポイント
  app.post("/api/stripe/create-checkout-session", async (req, res) => {
    try {
      const { planType, email } = req.body;
      // Stripeが環境変数に設定されていない場合のシミュレーションフォールバック
      const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

      if (!stripeSecretKey) {
        // Stripe未接続時はシミュレーションモードとして即時ライセンス発行とメール連携をシミュレート
        const demoLicense = createNewLicense({
          email: email || "demo-buyer@example.com",
          type: planType === "subscription" ? "subscription" : "lifetime",
          notes: "Stripeシミュレーション決済（開発環境）",
        });

        await notifyMailService({
          email: demoLicense.email,
          code: demoLicense.code,
          type: demoLicense.type,
          expiresAt: demoLicense.expiresAt,
        });

        return res.json({
          success: true,
          mode: "simulation",
          message: "Stripeシミュレーション決済が完了し、認証コードが発行されました。",
          license: demoLicense,
        });
      }

      // 実際のStripe利用時のリダイレクトURL生成等（Stripe SDK連携時）
      return res.json({
        success: true,
        mode: "live",
        checkoutUrl: "https://checkout.stripe.com/pay/...",
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });


  // AI EA Generation & Customization endpoint
  app.post("/api/generate-custom-ea", async (req, res) => {
    try {
      const {
        pair,
        timeframe,
        desiredPf,
        maxDrawdown,
        frequency,
        strategyType,
        customPrompt,
      } = req.body;

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error: "GEMINI_API_KEY is not configured.",
          fallback: true,
        });
      }

      const prompt = `あなたはMQL5およびMQL4開発の世界的トップエキスパート兼GogoJungle販売実績多数のプロシステムトレーダーです。
販売用EA（購入者が安心して使えるプロフェッショナル品質の自動売買プログラム）を開発してください。

【ユーザーの希望仕様】
- 通貨ペア: ${pair}
- 時間足: ${timeframe}
- 目標PF (プロフィットファクター): ${desiredPf}
- 許容最大ドローダウン: ${maxDrawdown}
- 希望取引頻度: ${frequency}
- 戦略アプローチ: ${strategyType || "高勝率マルチタイムフレーム・トレンドフォロー＆ボラティリティブレイク"}
${customPrompt ? `- 追加の要望・手法指定: ${customPrompt}` : ""}

【厳格な品質・エラー防止基準】
1. ゼロ除算の完全防止（_Point, ATR, TickSize, 価格差分を割る前の > 0 判定）
2. ロット正規化（MODE_MINLOT, MODE_LOTSTEP, MODE_MAXLOTの確認とNormalizeDouble）
3. スプレッドフィルター（急激なスプレッド拡大時のエントリー拒否）
4. マジックナンバー設定（他のEAと混ざらないユニーク識別子）
5. 動的ATR SL/TP または 固定Pips SL/TPの厳格適用（ノーポジ保護、ストップロス必須）
6. 週末強制決済または週末エントリー制限オプション
7. 購入者がMT4/MT5の設定画面（Inputs）で日本語で分かりやすく設定できるパラメータ構造

【出力形式】
JSON形式で以下のキーを含めて返してください：
{
  "eaName": "販売用EA名称（例: TrendPulse Pro M30）",
  "concept": "手法のロジック概要・なぜ勝てるのか・カーブフィッティング対策の解説（300文字程度）",
  "recommendedSettings": {
    "pair": "推奨通貨ペア",
    "timeframe": "推奨時間足",
    "riskPercent": "推奨リスク%",
    "tpPips": "TP目安",
    "slPips": "SL目安"
  },
  "mql5Code": "完全動作するMQL5ソースコード（//+------------------------------------+からOnTick(), OnDeinit()まで完全にコンパイルエラー無しの完全コード）",
  "mql4Code": "完全動作するMQL4ソースコード（MT4用）",
  "safetyChecks": [
    "ゼロ除算チェック済み",
    "ロット正規化チェック済み",
    "スプレッドフィルター内蔵",
    "マジックナンバー分離確認済み"
  ],
  "salesHeadline": "GogoJungle販売用キャッチコピー",
  "salesDescription": "販売用商品説明文（特徴、メリット、リスク説明）"
}`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.3,
        },
      });

      const text = response.text || "{}";
      const parsed = JSON.parse(text);
      res.json({ success: true, data: parsed });
    } catch (err: any) {
      console.error("Gemini EA Generation Error:", err);
      res.status(500).json({ error: err.message || "Failed to generate EA" });
    }
  });

  // Code verification endpoint
  app.post("/api/verify-code", (req, res) => {
    try {
      const { code, language } = req.body;
      if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Code is required" });
      }

      const issues: { severity: "error" | "warning" | "info"; message: string }[] = [];
      const checks: { name: string; passed: boolean; details: string }[] = [];

      // Check 1: Zero divide danger
      const hasDivision = /\/\s*([a-zA-Z0-9_]+|\([^)]+\))/.test(code);
      const hasZeroCheck = /if\s*\([^)]*(>|!=)\s*0/i.test(code) || /Point\s*>\s*0/.test(code);
      checks.push({
        name: "ゼロ除算防止チェック",
        passed: hasZeroCheck || !hasDivision,
        details: hasZeroCheck
          ? "除算前のゼロ判定ガードが検出されました。"
          : "除算式があります。分母が0にならないようガード文を確認してください。",
      });

      // Check 2: Lot normalization
      const hasLotNorm =
        /NormalizeDouble/i.test(code) ||
        /MODE_LOTSTEP/i.test(code) ||
        /SYMBOL_VOLUME_STEP/i.test(code) ||
        /LotStep/i.test(code);
      checks.push({
        name: "ロットサイズ正規化 & 最小/最大Lot制限",
        passed: hasLotNorm,
        details: hasLotNorm
          ? "ロット正規化関数またはロットステップ計算が実装されています。"
          : "取引所ごとの最小Lot/LotStepで正規化するコードを追加することをお勧めします。",
      });

      // Check 3: Magic Number
      const hasMagic = /Magic|InpMagic|MAGIC_NUMBER/i.test(code);
      checks.push({
        name: "マジックナンバー識別子",
        passed: hasMagic,
        details: hasMagic
          ? "マジックナンバーによる他EAポジションとの分離が確認されました。"
          : "マジックナンバーのInputパラメータを追加してください。",
      });

      // Check 4: StopLoss / TakeProfit
      const hasSL = /StopLoss|InpSL|SL|TakeProfit|InpTP|TP/i.test(code);
      checks.push({
        name: "ストップロス(SL) / 利確(TP) 保護",
        passed: hasSL,
        details: hasSL
          ? "SL/TP設定または動的損切りロジックが組み込まれています。"
          : "急変動時の資金保護のため必ずSLを定義してください。",
      });

      // Check 5: Spread Filter
      const hasSpreadFilter =
        /Spread|SYMBOL_SPREAD|MODE_SPREAD|MaxSpread/i.test(code);
      checks.push({
        name: "スプレッド拡大フィルター",
        passed: hasSpreadFilter,
        details: hasSpreadFilter
          ? "スプレッドフィルターによる高コスト時の取引抑制が組み込まれています。"
          : "経済指標時や早朝スプレッド拡大時の取引防止フィルター推奨です。",
      });

      // Check 6: Core MT4/MT5 Event Handlers
      const hasOnTick = /void\s+OnTick\s*\(/i.test(code) || /int\s+start\s*\(/i.test(code);
      checks.push({
        name: "メイン取引イベント関数 (OnTick)",
        passed: hasOnTick,
        details: hasOnTick
          ? "OnTick() メインループが正常に定義されています。"
          : "OnTick() が見当たりません。EAとして動作しません。",
      });

      const allErrors = checks.filter((c) => !c.passed && c.name.includes("メイン取引"));
      res.json({
        success: true,
        isValid: allErrors.length === 0,
        score: Math.round((checks.filter((c) => c.passed).length / checks.length) * 100),
        checks,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sales Copy & Manual Generator
  app.post("/api/generate-sales-copy", async (req, res) => {
    try {
      const { eaName, pair, timeframe, backtestStats, logicConcept } = req.body;

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error: "GEMINI_API_KEY is not configured.",
          fallback: true,
        });
      }

      const prompt = `あなたはGogoJungle（ゴゴジャン）やMQL5 Marketで累計数千本以上のEAを販売しているトッププロ出品者です。
以下のEAスペックに基づいて、購入者の信頼を最大限に獲得し、購入後にクレームやトラブルが起きない、極めて高品質な販売用マニュアル＆商品説明ページ全文を作成してください。

【EAスペック】
- EA名: ${eaName}
- 推奨通貨ペア: ${pair}
- 推奨時間足: ${timeframe}
- バックテスト実績:
  * プロフィットファクター (PF): ${backtestStats.pf}
  * 勝率: ${backtestStats.winRate}%
  * 最大ドローダウン: ${backtestStats.maxDrawdown}%
  * 週平均取引回数: ${backtestStats.tradesPerWeek}回
  * 総取引数: ${backtestStats.totalTrades}回
- ロジック解説: ${logicConcept}

【出力内容】
以下の構成で、丁寧かつ魅力的なマークダウン形式で出力してください：
1. 【キャッチコピー】（魅力的な短い見出し3点）
2. 【商品の特徴・コンセプト】（なぜ勝ち続けられるのか、過剰最適化をどう避けているか）
3. 【バックテスト結果の分析と透明性】
4. 【購入者向け初期設定ガイド】（MT4/MT5への導入手順、推奨証拠金、推奨ブローカー、VPSの必要性）
5. 【全パラメータ詳細解説表】（各設定項目の意味、デフォルト値、推奨変更範囲）
6. 【資金管理とリスク管理の鉄則】
7. 【よくある質問（Q&A 5選）】
8. 【注意事項・免責事項】`;

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
      });

      res.json({ success: true, text: response.text });
    } catch (err: any) {
      console.error("Sales Copy Generation Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`簡単EA作成ツール EA Maker Zero server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
