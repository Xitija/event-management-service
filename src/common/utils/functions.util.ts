export const compareArrays = (a: number[], b: number[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  a.sort((a, b) => a - b);
  b.sort((a, b) => a - b);
  // Comparing each element of your array
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

export const getNextDay = (currentDate: Date): Date => {
  // Create a new date object based on the current date
  const nextDay = new Date(currentDate);

  // Add one day
  nextDay.setDate(currentDate.getDate() + 1);

  return nextDay;
};
