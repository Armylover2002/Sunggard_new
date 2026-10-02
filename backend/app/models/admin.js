import mongoose from "mongoose";
import bcrypt from "bcrypt";

const adminSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    phone: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      default: "admin",
    },
    isVerified: {
      type: Boolean,
      default: true, // Internal admins might be verified by default or via admin code
    },

    lastLogin: Date,

    // Forgot-password OTP (email). Hashed, same as the customer OTP flow —
    // the raw code is never stored.
    otpHash: { type: String, select: false },
    otpExpiresAt: { type: Date, select: false },
    otpFailedAttempts: { type: Number, default: 0, select: false },
    otpLockedUntil: { type: Date, select: false },

    // Short-lived token issued once the OTP above is verified, so the
    // "set new password" step doesn't need the OTP re-entered.
    resetTokenHash: { type: String, select: false },
    resetTokenExpiresAt: { type: Date, select: false },
  },
  { timestamps: true },
);

// Hash password before saving
adminSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password
adminSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

export default mongoose.model("Admin", adminSchema);
