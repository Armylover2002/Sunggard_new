import mongoose from "mongoose";

const faqSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
    // Which app's help section this shows in. Not a full role enum on
    // purpose — "General" covers anything not specific to one app.
    category: {
      type: String,
      enum: ["Customer", "Rider", "Seller", "General"],
      default: "Customer",
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
    },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

faqSchema.index({ category: 1, status: 1, order: 1 });

export default mongoose.model("Faq", faqSchema);
