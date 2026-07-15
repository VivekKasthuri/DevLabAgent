#!/usr/bin/env python3
"""finetune-qlora.py — QLoRA fine-tune a US-origin base model on DevLab training data.

Runs on a single 24GB GPU (RTX 3090/4090, A10G) or free Colab/Kaggle T4
(use --base meta-llama/Llama-3.2-3B-Instruct there).

Setup (once):
    pip install unsloth            # pulls torch, transformers, peft, trl, bitsandbytes

Usage:
    # Default: CodeLlama 34B — all languages (Swift, Kotlin, Dart, RN, JS, Python, Go, Rust, Java)
    python scripts/finetune-qlora.py --data train.jsonl

    # Smaller model (fits on 16GB VRAM):
    python scripts/finetune-qlora.py --base meta-llama/Llama-3.1-8B-Instruct --data train.jsonl

    # More epochs for better results:
    python scripts/finetune-qlora.py --data train.jsonl --epochs 5

Output:
    out/devlab-coder/          merged fp16 model
    out/devlab-coder-q4.gguf   quantized weights ready for Ollama:
                               scripts/create-devlab-model.sh --gguf out/devlab-coder-q4.gguf
"""
import argparse, sys

# ── Model options (US-origin only) ─────────────────────────────────────────────
# CodeLlama 34B: best for all programming languages including Swift/Kotlin/Dart
# Llama 3.1 8B:  lighter, still strong, fits 16GB VRAM
# Llama 3.1 70B: best quality, needs 2x 40GB GPU
RECOMMENDED_MODELS = {
    "34b": "codellama/CodeLlama-34b-Instruct-hf",   # best all-language (default)
    "8b":  "meta-llama/Llama-3.1-8B-Instruct",      # lighter, 16GB VRAM
    "70b": "meta-llama/Llama-3.1-70B-Instruct",     # best quality, 80GB VRAM
    "13b": "codellama/CodeLlama-13b-Instruct-hf",   # balanced
}

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data",    default="train.jsonl",
                   help="Training data file (JSONL, chat format)")
    p.add_argument("--base",    default=RECOMMENDED_MODELS["34b"],
                   help="Base model. Shortcuts: 8b, 13b, 34b, 70b")
    p.add_argument("--epochs",  type=int,   default=3,
                   help="Training epochs (3-5 recommended)")
    p.add_argument("--lr",      type=float, default=2e-4,
                   help="Learning rate")
    p.add_argument("--max-seq", type=int,   default=8192,
                   help="Max sequence length (higher = more context, more VRAM)")
    p.add_argument("--lora-r",  type=int,   default=32,
                   help="LoRA rank — higher = more capacity, more VRAM (16/32/64)")
    p.add_argument("--batch",   type=int,   default=2,
                   help="Batch size per GPU")
    p.add_argument("--out",     default="out/devlab-coder",
                   help="Output directory for merged model")
    p.add_argument("--name",    default="devlab-coder",
                   help="Ollama model name after deployment")
    args = p.parse_args()

    # Resolve shortcuts
    if args.base in RECOMMENDED_MODELS:
        args.base = RECOMMENDED_MODELS[args.base]

    print(f"\n  DevLab Fine-Tune Pipeline")
    print(f"  ══════════════════════════")
    print(f"  Base model : {args.base}")
    print(f"  Training   : {args.data}")
    print(f"  Epochs     : {args.epochs}")
    print(f"  LoRA rank  : {args.lora_r}")
    print(f"  Max seq    : {args.max_seq}")
    print(f"  Output     : {args.out}\n")

    try:
        from unsloth import FastLanguageModel
    except ImportError:
        sys.exit(
            "unsloth not installed.\n"
            "Run: pip install unsloth\n"
            "Needs a CUDA GPU. For CPU-only: use Google Colab (free T4)."
        )

    import os
    from datasets import load_dataset
    from trl import SFTTrainer, SFTConfig

    # ── Load base model with 4-bit quantization (QLoRA) ──────────────────────
    print("Loading base model...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.base,
        max_seq_length=args.max_seq,
        load_in_4bit=True,     # 4-bit base = ~8-10GB VRAM for 34B
        token=os.environ.get("HF_TOKEN"),  # needed for gated models (Llama 3.x)
    )

    # ── Attach LoRA adapters (only these layers are trained) ─────────────────
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        use_gradient_checkpointing="unsloth",  # saves ~30% VRAM
        random_state=42,
    )

    # ── Prepare dataset ───────────────────────────────────────────────────────
    print("Loading training data...")
    ds = load_dataset("json", data_files=args.data, split="train")
    print(f"  {len(ds)} training examples")

    ds = ds.map(lambda ex: {
        "text": tokenizer.apply_chat_template(
            ex["messages"], tokenize=False, add_generation_prompt=False
        )
    })

    # ── Train ─────────────────────────────────────────────────────────────────
    print("Starting training...")
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        args=SFTConfig(
            dataset_text_field="text",
            max_seq_length=args.max_seq,
            per_device_train_batch_size=args.batch,
            gradient_accumulation_steps=4,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            fp16=True,
            logging_steps=10,
            output_dir=args.out + "-checkpoints",
            save_steps=100,
            optim="adamw_8bit",
            warmup_ratio=0.03,
            lr_scheduler_type="cosine",
            seed=42,
            report_to="none",
        ),
    )

    trainer_stats = trainer.train()
    print(f"\n  Training complete!")
    print(f"  Time: {trainer_stats.metrics['train_runtime']:.0f}s")
    print(f"  Loss: {trainer_stats.metrics['train_loss']:.4f}")

    # ── Export merged model + GGUF for Ollama ────────────────────────────────
    print("\nExporting merged model (fp16)...")
    model.save_pretrained_merged(args.out, tokenizer, save_method="merged_16bit")

    print("Exporting quantized GGUF (q4_k_m — best quality/size tradeoff)...")
    gguf_path = args.out + "-q4.gguf"
    model.save_pretrained_gguf(gguf_path, tokenizer, quantization_method="q4_k_m")

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"""
  ✅ Done!

  Files:
    {args.out}/          — merged fp16 model
    {gguf_path}  — quantized for Ollama

  Deploy to Ollama (run on your server):
    bash scripts/create-devlab-model.sh --gguf {gguf_path} --name {args.name}

  Or manually:
    cat > Modelfile << 'EOF'
FROM {gguf_path}
SYSTEM "You are DevLab, an expert coding agent for Swift, Kotlin, Flutter/Dart, React Native, JS/TS, Python, Go, Rust, Java."
PARAMETER temperature 0.1
PARAMETER num_ctx 16384
EOF
    ollama create {args.name} -f Modelfile
    ollama run {args.name} "Write a Swift function to fetch JSON"
""")

if __name__ == "__main__":
    main()

