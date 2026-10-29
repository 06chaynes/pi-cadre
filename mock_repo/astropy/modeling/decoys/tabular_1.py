class TabularModel:
    def __init__(self, table):
        self.table = table
    def lookup(self, k):
        return self.table.get(k, 0)
