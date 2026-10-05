import axiosInstance from "@core/api/axios";

/** The language notifications are sent in for the signed-in account. */
export const getPushLanguage = async () => {
  const res = await axiosInstance.get("/push/language");
  return res.data?.result?.language || "en";
};

/** Saves the language; the backend sends future notifications in it. */
export const setPushLanguage = async (language) => {
  const res = await axiosInstance.put("/push/language", { language });
  return res.data?.result?.language || language;
};
